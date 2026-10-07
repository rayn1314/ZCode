import assert from "node:assert/strict";
import test from "node:test";

import { EditErrorCode, type MessagePart, type MessageWithParts } from "@zcode/contracts";

import { hydrateReadFileStateFromSession } from "../src/agent/read-file-state-hydrator.js";
import { editToolEntry } from "../src/tool/handlers/edit.js";
import { resolveWorkspacePath } from "../src/tool/path-policy.js";
import { createReadFileStateKey } from "../src/tool/read-file-state.js";
import type {
  ReadFileStateEntry,
  ReadFileStateMap,
  ToolExecutionContext,
} from "../src/tool/types.js";

/**
 * Edit 读状态闸门契约（spec: core/spec/edit-read-state-gate.md）：
 * - 从未读过的文件拒绝编辑（read-before-edit 门槛保留）；
 * - token cap 截断的 partial view 放行：old_string 唯一性 + expectedRevision 乐观锁兜底，
 *   stale 校验继续生效——此前误报"没读过"会逼模型重读仍被截断的视图，无法自纠；
 * - 同一 runtime 内连续 Edit 共享 readFileState，第二次 Edit 不要求重读；
 * - 带 freshness metadata 的 range Read 跨 resume 恢复，无 metadata 的仍跳过。
 */

const WORK_DIR = process.cwd().replaceAll("\\", "/");

function createStubFile(
  content: string,
  mtimeMs: number,
): {
  file: { content: string; mtimeMs: number };
  port: unknown;
} {
  const file = { content, mtimeMs };
  const revision = () => ({
    id: `mtime:${Math.trunc(file.mtimeMs)}:size:${Buffer.byteLength(file.content, "utf8")}`,
    mtimeMs: file.mtimeMs,
    sizeBytes: Buffer.byteLength(file.content, "utf8"),
  });
  const port = {
    stat: async () => ({
      path: "stub",
      kind: "file",
      sizeBytes: revision().sizeBytes,
      revision: revision(),
    }),
    readTextFile: async () => ({
      content: file.content,
      encoding: "utf8",
      lineEndings: "LF",
      truncated: false,
      sizeBytes: revision().sizeBytes,
      revision: revision(),
    }),
    writeTextFile: async (request: { content: string; expectedRevision?: { id: string } }) => {
      if (request.expectedRevision && request.expectedRevision.id !== revision().id) {
        throw new Error("revision conflict");
      }
      file.content = request.content;
      file.mtimeMs += 1;
      return {
        path: "stub",
        bytesWritten: Buffer.byteLength(request.content, "utf8"),
        revision: revision(),
      };
    },
    listDirectory: async () => ({ entries: [] }),
  };
  return { file, port };
}

function createContext(readFileState: ReadFileStateMap, port: unknown): ToolExecutionContext {
  return {
    toolCallId: "call-1",
    traceId: "trace-1",
    spanId: "span-1",
    sessionId: "session-1",
    turnId: "turn-1",
    abortSignal: new AbortController().signal,
    fileSystemPort: port,
    readFileState,
    workingDirectory: WORK_DIR,
    workspaceRoot: WORK_DIR,
    memoryRoot: undefined,
  } as unknown as ToolExecutionContext;
}

function resolvedPath(): string {
  return resolveWorkspacePath({
    inputPath: "foo.ts",
    operation: "write",
    workingDirectory: WORK_DIR,
    workspaceRoot: WORK_DIR,
  });
}

function readEntry(
  path: string,
  content: string,
  mtimeMs: number,
  overrides: Partial<ReadFileStateEntry> = {},
): ReadFileStateEntry {
  return {
    path,
    content,
    offset: undefined,
    limit: undefined,
    isPartialView: false,
    readAt: new Date(1000),
    sourceTool: "Read",
    revisionId: `mtime:${mtimeMs}:size:${Buffer.byteLength(content, "utf8")}`,
    mtimeMs,
    sizeBytes: Buffer.byteLength(content, "utf8"),
    ...overrides,
  };
}

async function runEdit(
  context: ToolExecutionContext,
  oldString: string,
  newString: string,
): Promise<{ failed: false; filePath: string } | { failed: true; errorCode: number }> {
  const output = await editToolEntry.handler(
    { file_path: "foo.ts", old_string: oldString, new_string: newString },
    context,
  );
  if (
    typeof output === "object" &&
    output !== null &&
    "result" in output &&
    (output as { result: unknown }).result === false
  ) {
    return { failed: true, errorCode: (output as { errorCode: number }).errorCode };
  }
  return { failed: false, filePath: (output as { filePath: string }).filePath };
}

test("edit gate: never-read file is rejected", async () => {
  const { port } = createStubFile("alpha\nbeta\n", 100);
  const readFileState: ReadFileStateMap = new Map();
  const result = await runEdit(createContext(readFileState, port), "alpha", "ALPHA");
  assert.deepEqual(result, { failed: true, errorCode: EditErrorCode.FILE_NOT_READ });
});

test("edit gate: partial view with unchanged file is allowed", async () => {
  const content = "alpha\nbeta\ngamma\n";
  const { file, port } = createStubFile(content, 100);
  const readFileState: ReadFileStateMap = new Map();
  readFileState.set(
    createReadFileStateKey(resolvedPath(), 1, undefined),
    readEntry(resolvedPath(), content, 100, { isPartialView: true }),
  );
  const result = await runEdit(createContext(readFileState, port), "beta", "BETA");
  assert.equal(result.failed, false);
  assert.equal(file.content, "alpha\nBETA\ngamma\n");
});

test("edit gate: partial view with changed file is still stale", async () => {
  const { port } = createStubFile("alpha\nbeta\n", 200);
  const readFileState: ReadFileStateMap = new Map();
  readFileState.set(
    createReadFileStateKey(resolvedPath(), 1, undefined),
    readEntry(resolvedPath(), "alpha\nbeta\n", 100, { isPartialView: true }),
  );
  const result = await runEdit(createContext(readFileState, port), "alpha", "ALPHA");
  assert.deepEqual(result, { failed: true, errorCode: EditErrorCode.STALE_FILE });
});

test("edit gate: consecutive edits share state without re-reading", async () => {
  const content = "alpha\nbeta\ngamma\n";
  const { port } = createStubFile(content, 100);
  const readFileState: ReadFileStateMap = new Map();
  readFileState.set(
    createReadFileStateKey(resolvedPath(), 1, undefined),
    readEntry(resolvedPath(), content, 100),
  );
  const context = createContext(readFileState, port);

  const first = await runEdit(context, "alpha", "ALPHA");
  assert.equal(first.failed, false);
  // Edit 成功后用写回 revision 更新 readFileState；第二次 Edit 直接基于新状态放行。
  const second = await runEdit(context, "beta", "BETA2");
  assert.equal(second.failed, false);
  const entry = readFileState.get(createReadFileStateKey(resolvedPath(), 1, undefined));
  assert.equal(entry?.content, "ALPHA\nBETA2\ngamma\n");
});

function readToolPart(input: Record<string, unknown>, metadata: unknown): MessagePart {
  return {
    id: "part-1",
    type: "tool",
    tool: "Read",
    state: {
      status: "completed",
      input,
      output: { type: "text", filePath: "stub", content: "" },
      ...(metadata === undefined ? {} : { metadata }),
    },
  } as unknown as MessagePart;
}

function assistantMessage(parts: MessagePart[]): MessageWithParts {
  return {
    info: { id: "m1", role: "assistant" },
    parts,
  } as unknown as MessageWithParts;
}

function readMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    readFileState: {
      schemaVersion: 1,
      tool: "Read",
      path: "/ws/foo.ts",
      content: "line\n".repeat(200),
      offset: 100,
      limit: 50,
      isPartialView: false,
      readAtMs: 1234,
      revisionId: "mtime:100:size:1000",
      mtimeMs: 100,
      sizeBytes: 1000,
      ...overrides,
    },
  };
}

test("hydrate: range read with freshness metadata is restored", async () => {
  const readFileState: ReadFileStateMap = new Map();
  const result = await hydrateReadFileStateFromSession({
    messages: [
      assistantMessage([
        readToolPart({ file_path: "/ws/foo.ts", offset: 100, limit: 50 }, readMetadata()),
      ]),
    ],
    readFileState,
    workingDirectory: "/ws",
    workspaceRoot: "/ws",
  });
  const entry = readFileState.get(createReadFileStateKey("/ws/foo.ts", 100, 50));
  assert.ok(entry, "range read entry should be restored");
  assert.equal(entry.offset, 100);
  assert.equal(entry.limit, 50);
  assert.equal(entry.isPartialView, false);
  assert.equal(result.restoredCount, 1);
  assert.equal(result.skippedRangeReadCount, 0);
});

test("hydrate: range read without metadata is still skipped", async () => {
  const readFileState: ReadFileStateMap = new Map();
  const result = await hydrateReadFileStateFromSession({
    messages: [
      assistantMessage([
        readToolPart({ file_path: "/ws/foo.ts", offset: 100, limit: 50 }, undefined),
      ]),
    ],
    readFileState,
    workingDirectory: "/ws",
    workspaceRoot: "/ws",
  });
  assert.equal(readFileState.size, 0);
  assert.equal(result.restoredCount, 0);
  assert.equal(result.skippedRangeReadCount, 1);
});

test("hydrate: full read restore keeps legacy key and partial flag", async () => {
  const readFileState: ReadFileStateMap = new Map();
  const result = await hydrateReadFileStateFromSession({
    messages: [
      assistantMessage([
        readToolPart(
          { file_path: "/ws/foo.ts" },
          readMetadata({ offset: undefined, limit: undefined, isPartialView: true }),
        ),
      ]),
    ],
    readFileState,
    workingDirectory: "/ws",
    workspaceRoot: "/ws",
  });
  const entry = readFileState.get(createReadFileStateKey("/ws/foo.ts", 1, undefined));
  assert.ok(entry, "full read entry should be restored");
  assert.equal(entry.isPartialView, true);
  assert.equal(result.restoredCount, 1);
  assert.equal(result.skippedRangeReadCount, 0);
});
