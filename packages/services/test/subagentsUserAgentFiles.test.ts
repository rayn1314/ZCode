import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { sealDataRoot } from "./helpers/sealedDataRoot.js";
import { createSubagentsService } from "../src/subagents/subagentsService.js";

/**
 * 用户级 agent 的 markdown 原文往返复制（spec `core/spec/subagent-settings-sync.md` D1）：
 * - 权威侧 `exportUserAgentFiles` 只读单层 markdown（与 profile 发现范围一致，不下钻子目录）；
 * - 副本侧 `replaceUserAgentFiles` 整份替换，快照外的 markdown 必须消失，其它文件不动；
 * - 副本侧只接受单层 markdown 文件名，路径跳转在落盘前就被拒绝。
 */
async function writeUserAgentFile(agentsDir: string, name: string, content: string): Promise<void> {
  await mkdir(agentsDir, { recursive: true });
  await writeFile(join(agentsDir, name), content, "utf8");
}

test("exportUserAgentFiles 读单层 markdown 原文，忽略子目录与非 markdown 文件", async () => {
  await using root = await sealDataRoot("zcode-subagent-files-export-");
  const agentsDir = join(root.dataRoot, "agents");
  await writeUserAgentFile(agentsDir, "coder.md", "# coder\n");
  await writeUserAgentFile(agentsDir, "reviewer.markdown", "# reviewer\n");
  await writeUserAgentFile(agentsDir, "notes.txt", "ignore\n");
  await writeUserAgentFile(join(agentsDir, "nested"), "deep.md", "# deep\n");

  const service = createSubagentsService();
  assert.deepEqual(await service.exportUserAgentFiles(), {
    files: [
      { name: "coder.md", content: "# coder\n" },
      { name: "reviewer.markdown", content: "# reviewer\n" },
    ],
  });
});

test("exportUserAgentFiles 在用户 agent 目录不存在时返回空快照", async () => {
  await using _root = await sealDataRoot("zcode-subagent-files-export-empty-");
  const service = createSubagentsService();
  assert.deepEqual(await service.exportUserAgentFiles(), { files: [] });
});

test("replaceUserAgentFiles 整份替换：快照外的 markdown 删除，其它文件与子目录不动", async () => {
  await using root = await sealDataRoot("zcode-subagent-files-replace-");
  const agentsDir = join(root.dataRoot, "agents");
  // 副本侧上一轮的残留：既要有该被删的 stale markdown，也要有不该被碰的旁路文件。
  await writeUserAgentFile(agentsDir, "stale.md", "# stale\n");
  await writeUserAgentFile(agentsDir, "notes.txt", "keep\n");
  await writeUserAgentFile(join(agentsDir, "nested"), "deep.md", "# deep\n");

  const service = createSubagentsService();
  const replaced = await service.replaceUserAgentFiles({
    files: [
      { name: "coder.md", content: "# coder v2\n" },
      { name: "reviewer.markdown", content: "# reviewer v2\n" },
    ],
  });

  assert.deepEqual(replaced, {
    files: [
      { name: "coder.md", content: "# coder v2\n" },
      { name: "reviewer.markdown", content: "# reviewer v2\n" },
    ],
  });
  assert.equal(await readFile(join(agentsDir, "coder.md"), "utf8"), "# coder v2\n");
  assert.equal(await readFile(join(agentsDir, "notes.txt"), "utf8"), "keep\n");
  assert.equal(await readFile(join(agentsDir, "nested", "deep.md"), "utf8"), "# deep\n");
  await assert.rejects(() => readFile(join(agentsDir, "stale.md"), "utf8"));
  // 副本的读取面必须与落盘一致：重读只剩快照内的两个文件。
  assert.deepEqual(await service.exportUserAgentFiles(), replaced);
});

test("replaceUserAgentFiles 用空快照清空用户 agent，非 markdown 文件保留", async () => {
  await using root = await sealDataRoot("zcode-subagent-files-clear-");
  const agentsDir = join(root.dataRoot, "agents");
  await writeUserAgentFile(agentsDir, "coder.md", "# coder\n");
  await writeUserAgentFile(agentsDir, "notes.txt", "keep\n");

  const service = createSubagentsService();
  assert.deepEqual(await service.replaceUserAgentFiles({ files: [] }), { files: [] });
  await assert.rejects(() => readFile(join(agentsDir, "coder.md"), "utf8"));
  assert.equal(await readFile(join(agentsDir, "notes.txt"), "utf8"), "keep\n");
});

test("replaceUserAgentFiles 拒绝越界或非 markdown 文件名，且拒绝发生在落盘之前", async () => {
  await using root = await sealDataRoot("zcode-subagent-files-reject-");
  const agentsDir = join(root.dataRoot, "agents");

  const service = createSubagentsService();
  for (const name of [
    "../escape.md",
    "nested/deep.md",
    "..\\escape.md",
    "notes.txt",
    " coder.md",
  ]) {
    await assert.rejects(
      () =>
        service.replaceUserAgentFiles({
          // 第一个文件合法：校验必须整体前置，否则坏名字会让半份快照先落盘。
          files: [
            { name: "coder.md", content: "# coder\n" },
            { name, content: "# escape\n" },
          ],
        }),
      /无效用户 agent 文件名/,
    );
  }
  await assert.rejects(() => readFile(join(agentsDir, "coder.md"), "utf8"));
});

test("replaceUserAgentFiles 拒绝畸形载荷，不把 profile 写成空文件", async () => {
  await using root = await sealDataRoot("zcode-subagent-files-malformed-");
  const agentsDir = join(root.dataRoot, "agents");

  const service = createSubagentsService();
  await assert.rejects(
    () =>
      service.replaceUserAgentFiles({
        files: [{ name: "coder.md", content: undefined as unknown as string }],
      }),
    /无效用户 agent 文件内容/,
  );
  await assert.rejects(() => readFile(join(agentsDir, "coder.md"), "utf8"));
});

test("权威写入成功后发「权威已变」信号；副本写入 replace* 不发", async () => {
  await using _root = await sealDataRoot("zcode-subagent-authority-signal-");
  const onAuthorityChanged = vi.fn();
  const service = createSubagentsService({ onAuthorityChanged });

  // 三项配置的写入都算权威变更（Host 据此广播副本，spec D1 时点 1）。
  await service.setBuiltInModelOverride({
    agentName: "general-purpose",
    modelSelection: { providerId: "prov-1", modelId: "u2-flash" },
  });
  expect(onAuthorityChanged).toHaveBeenCalledTimes(1);

  // 副本写入是「被推过来的结果」，不能反过来再广播一次，否则副本循环互相覆盖。
  await service.replaceSubagentState(await service.getSubagentState());
  await service.replaceUserAgentFiles({ files: [{ name: "coder.md", content: "# coder\n" }] });
  expect(onAuthorityChanged).toHaveBeenCalledTimes(1);
});
