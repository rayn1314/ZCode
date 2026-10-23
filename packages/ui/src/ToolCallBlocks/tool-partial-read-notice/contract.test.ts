import { describe, expect, it } from "vitest";

import { toolPartialReadNoticeModule } from "./module.js";
import {
  detectTruncationNotice,
  formatSearchRangeLabel,
  resolveOutputText,
  resolveReadRange,
  resolveSearchRange,
} from "./contract.js";

// 契约测试只 import contract 与 module，不知道实现是谁；同一份测试应同时跑真实现与跨进程代理。
type ToolCallSnapshot = Parameters<typeof detectTruncationNotice>[0];

function call(output?: unknown, raw?: unknown): ToolCallSnapshot {
  return { output, raw };
}

describe("tool-partial-read-notice contract", () => {
  it("declares its module manifest", () => {
    expect(toolPartialReadNoticeModule.id).toBe("tool-partial-read-notice");
  });

  it("单卡最多一枚徽标：多标记并存时按固定优先级取第一个", () => {
    const all =
      "Wasted call — file unchanged … Showing a partial view of lines 1-10 of 99. " +
      "[Showing results with pagination = limit: 250] [WebFetch content truncated before prompt processing]";
    expect(detectTruncationNotice(call(all))?.kind).toBe("unchanged");
    expect(
      detectTruncationNotice(call(all.replace("Wasted call — file unchanged … ", "")))?.kind,
    ).toBe("partialView");
  });

  it("grep 截断必须要有 limit: 证据，只有 offset 分页不算截断", () => {
    // fs/index.ts 的 applyHeadLimit：appliedOffset>0 且未截断时也会输出分页信息。
    expect(
      detectTruncationNotice(call("a.ts:1\n\n[Showing results with pagination = offset: 100]")),
    ).toBe(null);
    expect(
      detectTruncationNotice(call("a.ts:1\n\n[Showing results with pagination = limit: 250]"))
        ?.limit,
    ).toBe(250);
  });

  it("解析不到就不显示：不猜、不兜底", () => {
    expect(detectTruncationNotice(call("1\tplain content"))).toBe(null);
    expect(detectTruncationNotice(call())).toBe(null);
    // 旧快照的 record 形态输出同样要能读到（历史会话覆盖）。
    expect(resolveOutputText(call(undefined, { rawOutput: { text: "1\tplain" } }))).toBe(
      "1\tplain",
    );
  });

  it("Read 范围以输出标记为准，input 只作兜底，整读不显示（null）", () => {
    const output =
      "<system-reminder>Showing a partial view of lines 1-2000 of 5432.</system-reminder>";
    expect(resolveReadRange({ offset: 1, limit: 5000 }, output)).toEqual({
      kind: "lines",
      start: 1,
      end: 2000,
    });
    expect(resolveReadRange({ offset: 2001 }, "")).toEqual({ kind: "lines", start: 2001 });
    expect(resolveReadRange({ offset: 1 }, "")).toBe(null);
  });

  it("Search 范围不吃 0 值缺省：head_limit=0 是「无限制」、offset=0 是缺省", () => {
    expect(resolveSearchRange({ head_limit: 0, offset: 0 })).toBe(null);
    expect(resolveSearchRange({ head_limit: 250, offset: 100 })).toEqual({
      headLimit: 250,
      offset: 100,
    });
    expect(formatSearchRangeLabel({ offset: 100 }, (id) => id)).toBe(
      "chat.toolCall.search.range.offset",
    );
  });
});
