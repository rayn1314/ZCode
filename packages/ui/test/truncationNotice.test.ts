// 截断徽标与读取范围推导契约。
// spec: packages/ui/spec/tool-call-range-and-truncation.md
//
// 标记字符串锚点表（UI 只读匹配，所有者在 CLI handler；CLI 改文案必须同步这里）：
// | 标记 | CLI 源文件 |
// | --- | --- |
// | `Wasted call — file unchanged` | apps/zcode-cli/packages/core/src/tool/handlers/read.ts (FILE_UNCHANGED_STUB) |
// | `Showing a partial view of lines X-Y of Z` | apps/zcode-cli/packages/core/src/tool/handlers/read-text.ts (createTokenCapPartialView) |
// | `with pagination = limit: N` / `Found N files limit: N` | apps/zcode-cli/packages/core/src/tool/handlers/grep.ts (formatGrepModelContent) + adapters/src/fs/index.ts (applyHeadLimit) |
// | `(Results are truncated` | apps/zcode-cli/packages/core/src/tool/handlers/glob.ts (formatGlobModelContent) |
// | `[WebFetch content truncated` | apps/zcode-cli/packages/core/src/tool/handlers/webfetch-content.ts |
// | `<persisted-output>` | apps/zcode-cli/packages/core/src/tool/result-persistence-format.ts |
// | `[Tool output truncated by resultBudget` | apps/zcode-cli/packages/core/src/tool/executor/result-serialization.ts |
import assert from "node:assert/strict";
import test from "node:test";
import {
  detectTruncationNotice,
  formatReadRangeLabel,
  formatSearchRangeLabel,
  resolveReadRange,
  resolveSearchRange,
} from "../src/ToolCallBlocks/truncationNotice.js";

function call(output?: unknown, raw?: unknown): { output?: unknown; raw?: unknown } {
  return { output, raw };
}

test("detectTruncationNotice：8 类标记逐一命中", () => {
  const cases: Array<[string, { output?: unknown; raw?: unknown }, string]> = [
    ["unchanged", call("Wasted call — file unchanged since your last Read. Refer…"), "unchanged"],
    [
      "partialView",
      call(
        "<system-reminder>…Showing a partial view of lines 1-2000 of 5432.</system-reminder>\n1\tfoo",
      ),
      "partialView",
    ],
    [
      "resultsTruncated(grep content)",
      call("a.ts:1\n\n[Showing results with pagination = limit: 250, offset: 0]"),
      "resultsTruncated",
    ],
    [
      "resultsTruncated(grep count)",
      call("a.ts:3\n\nFound 3 total occurrences across 1 file with pagination = limit: 250"),
      "resultsTruncated",
    ],
    [
      "resultsTruncated(grep files)",
      call("Found 250 files limit: 250\na.ts\nb.ts"),
      "resultsTruncated",
    ],
    [
      "resultsTruncated(glob)",
      call("a.ts\nb.ts\n(Results are truncated. Consider using a more specific path or pattern.)"),
      "resultsTruncated",
    ],
    [
      "webfetch",
      call("content\n\n[WebFetch content truncated before prompt processing]"),
      "webfetch",
    ],
    ["persisted", call("<persisted-output>\npreview\n</persisted-output>"), "persisted"],
    [
      "budget",
      call(
        "short\n\n[Tool output truncated by resultBudget: originalBytes=100000, maxModelBytes=100000, strategy=truncate]",
      ),
      "budget",
    ],
    [
      "displayTruncated",
      call(undefined, { display: { kind: "bash_output", truncated: true } }),
      "displayTruncated",
    ],
    [
      "previewHeadTail",
      call(undefined, { outputTruncated: { totalBytes: 200000, ref: "tool-output/1" } }),
      "previewHeadTail",
    ],
    [
      "旧快照 record 形态 rawOutput",
      call(undefined, {
        rawOutput: { text: "Wasted call — file unchanged since your last Read." },
      }),
      "unchanged",
    ],
  ];

  for (const [name, toolCall, expected] of cases) {
    assert.equal(detectTruncationNotice(toolCall)?.kind, expected, name);
  }
});

test("detectTruncationNotice：无标记返回 null（不猜不兜底）", () => {
  assert.equal(detectTruncationNotice(call("1\tplain content")), null);
  assert.equal(detectTruncationNotice(call(undefined, {})), null);
  assert.equal(detectTruncationNotice(call()), null);
});

test("grep 分页但未截断（仅 offset）不算截断——appliedLimit 只在真截断时置位", () => {
  // fs/index.ts applyHeadLimit: appliedOffset>0 时未截断也会输出 offset 分页信息。
  const offsetOnly = call("a.ts:1\n\n[Showing results with pagination = offset: 100]");
  assert.equal(detectTruncationNotice(offsetOnly), null);
});

test("resultsTruncated 解析 limit 数值", () => {
  const notice = detectTruncationNotice(
    call("x\n\n[Showing results with pagination = limit: 300, offset: 0]"),
  );
  assert.equal(notice?.kind, "resultsTruncated");
  assert.equal(notice?.limit, 300);
});

test("优先级：未变更 > 部分视图 > 结果超限 > … > 仅头尾", () => {
  // 多标记并存时按固定序取第一个。
  const all =
    "Wasted call — file unchanged … Showing a partial view of lines 1-10 of 99. " +
    "[Showing results with pagination = limit: 250] [WebFetch content truncated before prompt processing] " +
    "<persisted-output></persisted-output> [Tool output truncated by resultBudget: x]";
  assert.equal(detectTruncationNotice(call(all))?.kind, "unchanged");

  const withoutUnchanged = all.replace("Wasted call — file unchanged … ", "");
  assert.equal(detectTruncationNotice(call(withoutUnchanged))?.kind, "partialView");

  const tailOnly = call("x", {
    display: { truncated: true },
    outputTruncated: { totalBytes: 1, ref: "r" },
  });
  assert.equal(detectTruncationNotice(tailOnly)?.kind, "displayTruncated");
});

test("resolveReadRange：partial-view 标记覆盖 input 推算", () => {
  const range = resolveReadRange(
    { offset: 1, limit: 5000 },
    "<system-reminder>Showing a partial view of lines 1-2000 of 5432.</system-reminder>\n1\tfoo",
  );
  assert.deepEqual(range, { kind: "lines", start: 1, end: 2000 });
});

test("resolveReadRange：input.offset/limit 四种组合", () => {
  assert.deepEqual(resolveReadRange({ offset: 2001, limit: 2000 }, ""), {
    kind: "lines",
    start: 2001,
    end: 4000,
  });
  assert.deepEqual(resolveReadRange({ offset: 2001 }, ""), { kind: "lines", start: 2001 });
  assert.deepEqual(resolveReadRange({ limit: 500 }, ""), { kind: "firstLines", limit: 500 });
  // offset≤1 且无 limit = 整读，不显示。
  assert.equal(resolveReadRange({ offset: 1 }, ""), null);
  assert.equal(resolveReadRange({}, ""), null);
  assert.equal(resolveReadRange(undefined, ""), null);
});

test("resolveReadRange：PDF pages 优先于 offset 推算", () => {
  assert.deepEqual(resolveReadRange({ pages: "1-3,5" }, ""), { kind: "pages", pages: "1-3,5" });
});

test("resolveReadRange：首行即超预算的 partial-view 变体无行范围，回落 input", () => {
  const range = resolveReadRange(
    { limit: 100 },
    "<system-reminder>Showing a partial view of the first line because the first line alone exceeds the token budget.</system-reminder>",
  );
  assert.deepEqual(range, { kind: "firstLines", limit: 100 });
});

test("resolveSearchRange：head_limit/offset 组合，0 与缺省不显示", () => {
  assert.deepEqual(resolveSearchRange({ head_limit: 250 }), { headLimit: 250 });
  assert.deepEqual(resolveSearchRange({ head_limit: 250, offset: 100 }), {
    headLimit: 250,
    offset: 100,
  });
  assert.deepEqual(resolveSearchRange({ offset: 100 }), { offset: 100 });
  // head_limit=0 是 CLI「无限制」语义；offset=0 是缺省——都不显示。
  assert.equal(resolveSearchRange({ head_limit: 0, offset: 0 }), null);
  assert.equal(resolveSearchRange({}), null);
  assert.equal(resolveSearchRange(undefined), null);
});

test("范围 label 走注入的 format（key 与取值）", () => {
  const spy = (id: string, values?: Record<string, string | number>) =>
    `${id}|${JSON.stringify(values ?? {})}`;

  assert.equal(
    formatReadRangeLabel({ kind: "lines", start: 2001, end: 4000 }, spy),
    'chat.toolCall.read.range.lines|{"start":2001,"end":4000}',
  );
  assert.equal(
    formatReadRangeLabel({ kind: "lines", start: 2001 }, spy),
    'chat.toolCall.read.range.linesFrom|{"start":2001}',
  );
  assert.equal(
    formatReadRangeLabel({ kind: "firstLines", limit: 500 }, spy),
    'chat.toolCall.read.range.firstLines|{"limit":500}',
  );
  assert.equal(
    formatReadRangeLabel({ kind: "pages", pages: "1-3,5" }, spy),
    'chat.toolCall.read.range.pages|{"pages":"1-3,5"}',
  );
  assert.equal(
    formatSearchRangeLabel({ headLimit: 250, offset: 100 }, spy),
    'chat.toolCall.search.range.limit|{"limit":250} · chat.toolCall.search.range.offset|{"offset":100}',
  );
});
