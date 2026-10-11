// 工具卡「读取范围 + 截断种类」的纯展示推导（spec: spec/tool-call-range-and-truncation.md）。
//
// 标记字符串的单一所有者是 apps/zcode-cli 各 handler，本文件只读匹配、不产生状态。
// 对应关系由 test/truncationNotice.test.ts 文件头锚定；CLI 改文案必须同步改这里的子串，
// 否则单测先红（宁可红在测试，不要静默丢徽标）。
import type { TaskChatToolCall } from "@/lib/taskChatMessageTypes.js";

export type TruncationNoticeKind =
  | "unchanged"
  | "partialView"
  | "resultsTruncated"
  | "webfetch"
  | "persisted"
  | "budget"
  | "displayTruncated"
  | "previewHeadTail";

export interface TruncationNotice {
  kind: TruncationNoticeKind;
  /** resultsTruncated 时从标记解析出的条数上限；解析不到则缺省。 */
  limit?: number;
}

export type ReadRange =
  | { kind: "lines"; start: number; end?: number }
  | { kind: "firstLines"; limit: number }
  | { kind: "pages"; pages: string };

export interface SearchRange {
  headLimit?: number;
  offset?: number;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 输出文本在 v4 是字符串、旧快照是 record（output/text/content 字段），两形态都收。 */
export function resolveOutputText(toolCall: Pick<TaskChatToolCall, "output" | "raw">): string {
  if (typeof toolCall.output === "string") {
    return toolCall.output;
  }

  const raw = toolCall.raw;
  if (typeof raw === "string") {
    return raw;
  }
  if (!isPlainRecord(raw)) {
    return "";
  }

  if (typeof raw.rawOutput === "string") {
    return raw.rawOutput;
  }
  if (isPlainRecord(raw.rawOutput)) {
    for (const key of ["output", "text", "content"] as const) {
      const candidate = raw.rawOutput[key];
      if (typeof candidate === "string" && candidate.length > 0) {
        return candidate;
      }
    }
  }

  return "";
}

function parseNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const rounded = Math.trunc(value);
  return rounded >= 0 ? rounded : undefined;
}

function parsePositiveInt(value: unknown): number | undefined {
  const parsed = parseNonNegativeInt(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

// Read token 上限的部分视图：CLI read-text.ts 写入
// `Showing a partial view of lines ${startLine}-${endLine} of ${totalLines}.`。
// 另有「首行即超预算」变体没有行范围，此时回落 input 推算。
const READ_PARTIAL_VIEW_PATTERN = /Showing a partial view of lines (\d+)-(\d+) of \d+\./;

/**
 * 卡片上要显示的读取范围。优先级（spec「Read 卡」）：
 * ① 输出 partial-view 标记（实际返回范围，token 上限可能比 limit 更短）→ ② input.pages →
 * ③ input.offset/limit 推算；全无 → null（整读不显示）。
 */
export function resolveReadRange(input: unknown, outputText: string): ReadRange | null {
  const partialView = outputText.match(READ_PARTIAL_VIEW_PATTERN);
  if (partialView) {
    return { kind: "lines", start: Number(partialView[1]), end: Number(partialView[2]) };
  }

  if (!isPlainRecord(input)) {
    return null;
  }

  if (typeof input.pages === "string" && input.pages.trim().length > 0) {
    return { kind: "pages", pages: input.pages.trim() };
  }

  const offset = parseNonNegativeInt(input.offset);
  const limit = parsePositiveInt(input.limit);
  const startFromOffset = offset !== undefined && offset > 1 ? offset : undefined;

  if (startFromOffset !== undefined && limit !== undefined) {
    return { kind: "lines", start: startFromOffset, end: startFromOffset + limit - 1 };
  }
  if (startFromOffset !== undefined) {
    return { kind: "lines", start: startFromOffset };
  }
  if (limit !== undefined) {
    return { kind: "firstLines", limit };
  }

  return null;
}

/**
 * Grep 分页范围。head_limit=0 是 CLI 侧「无限制」语义，不当作范围显示；
 * CLI 的 250 默认值只存在于服务端，input 未传时不显示（那是缺省不是用户意图）。
 */
export function resolveSearchRange(input: unknown): SearchRange | null {
  if (!isPlainRecord(input)) {
    return null;
  }

  const headLimit = parsePositiveInt(input.head_limit);
  const offset = parseNonNegativeInt(input.offset);
  const range: SearchRange = {};
  if (headLimit !== undefined) {
    range.headLimit = headLimit;
  }
  if (offset !== undefined && offset > 0) {
    range.offset = offset;
  }

  return range.headLimit !== undefined || range.offset !== undefined ? range : null;
}

/** 注入 formatMessage 而非 import intl：保持本模块纯函数可单测。 */
type FormatMessage = (id: string, values?: Record<string, string | number>) => string;

export function formatReadRangeLabel(range: ReadRange, format: FormatMessage): string {
  switch (range.kind) {
    case "lines":
      return range.end !== undefined
        ? format("chat.toolCall.read.range.lines", { start: range.start, end: range.end })
        : format("chat.toolCall.read.range.linesFrom", { start: range.start });
    case "firstLines":
      return format("chat.toolCall.read.range.firstLines", { limit: range.limit });
    case "pages":
      return format("chat.toolCall.read.range.pages", { pages: range.pages });
  }
}

export function formatSearchRangeLabel(range: SearchRange, format: FormatMessage): string {
  const parts: string[] = [];
  if (range.headLimit !== undefined) {
    parts.push(format("chat.toolCall.search.range.limit", { limit: range.headLimit }));
  }
  if (range.offset !== undefined) {
    parts.push(format("chat.toolCall.search.range.offset", { offset: range.offset }));
  }
  return parts.join(" · ");
}

// Grep 截断标记（grep.ts formatGrepModelContent）：appliedLimit 仅在真截断时置位
// （fs/index.ts applyHeadLimit），而 offset>0 未截断时也会输出分页信息——
// 因此必须要求 `limit:` 证据才算截断，只匹配 pagination/offset 会产生假阳性。
// 三种输出模式三种拼法：content/count 带 "with pagination = limit:"，files_with_matches
// 是 "Found N files limit:"。Glob 截断见 glob.ts formatGlobModelContent。
const GREP_TRUNCATED_PATTERNS = [
  /with pagination = limit:\s*(\d+)/,
  /^Found \d+ files limit:\s*(\d+)/m,
];
const GLOB_TRUNCATED_MARKER = "(Results are truncated";

// 以下标记均逐一对照 CLI 源文件（见 test 文件头锚点表）。
const UNCHANGED_MARKER = "Wasted call — file unchanged"; // core/tool/handlers/read.ts FILE_UNCHANGED_STUB
const PARTIAL_VIEW_MARKER = "Showing a partial view of lines"; // core/tool/handlers/read-text.ts
const WEBFETCH_TRUNCATED_MARKER = "[WebFetch content truncated"; // core/tool/handlers/webfetch-content.ts
const PERSISTED_OUTPUT_MARKER = "<persisted-output>"; // core/tool/result-persistence-format.ts
const RESULT_BUDGET_MARKER = "[Tool output truncated by resultBudget"; // core/tool/executor/result-serialization.ts

function detectResultsTruncated(outputText: string): TruncationNotice | null {
  for (const pattern of GREP_TRUNCATED_PATTERNS) {
    const matched = outputText.match(pattern);
    if (matched) {
      return matched[1] !== undefined
        ? { kind: "resultsTruncated", limit: Number(matched[1]) }
        : { kind: "resultsTruncated" };
    }
  }

  if (outputText.includes(GLOB_TRUNCATED_MARKER)) {
    return { kind: "resultsTruncated" };
  }

  return null;
}

/**
 * 单卡最多一枚截断徽标，按固定优先级取第一个命中；全部未命中返回 null（不猜测不兜底）。
 * 顺序见 spec 截断徽标表：最能解释用户疑惑的排前面。
 */
export function detectTruncationNotice(
  toolCall: Pick<TaskChatToolCall, "output" | "raw">,
): TruncationNotice | null {
  const outputText = resolveOutputText(toolCall);

  if (outputText.includes(UNCHANGED_MARKER)) {
    return { kind: "unchanged" };
  }
  if (outputText.includes(PARTIAL_VIEW_MARKER)) {
    return { kind: "partialView" };
  }

  const resultsTruncated = detectResultsTruncated(outputText);
  if (resultsTruncated) {
    return resultsTruncated;
  }
  if (outputText.includes(WEBFETCH_TRUNCATED_MARKER)) {
    return { kind: "webfetch" };
  }
  if (outputText.includes(PERSISTED_OUTPUT_MARKER)) {
    return { kind: "persisted" };
  }
  if (outputText.includes(RESULT_BUDGET_MARKER)) {
    return { kind: "budget" };
  }

  const raw = toolCall.raw;
  if (isPlainRecord(raw)) {
    // bash_output 等 display payload 的截断布尔（如 execute 卡已解析未渲染的那枚）。
    if (isPlainRecord(raw.display) && raw.display.truncated === true) {
      return { kind: "displayTruncated" };
    }
    if (raw.outputTruncated !== undefined && raw.outputTruncated !== null) {
      return { kind: "previewHeadTail" };
    }
  }

  return null;
}
