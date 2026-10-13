// 行身份空间识别与翻转重锚定（冷打开窗口态负数行号 ⇄ 权威全序）契约。
// spec: apps/zcode-cli/packages/bootstrap/spec/cold-open-window-first.md §A/B。
//
// 单独运行：npx vitest run packages/ui/test/v4ConversationRowIdentitySpace.test.ts
import { expect, it } from "vitest";
import {
  didRowIdentitySpaceFlip,
  isColdWindowRowSpace,
  resolveRowSpaceFlipScrollTop,
  type RowSpaceBaseline,
} from "../src/v4/conversationRowIdentitySpace.js";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

/** 只需要 rowId：判定与重锚定都只依赖行号身份。 */
function rowsOf(rowIds: number[]): ConversationRow[] {
  return rowIds.map((rowId) => ({ rowId }) as ConversationRow);
}

function baselineOf(
  rows: ConversationRow[],
  anchor?: RowSpaceBaseline["anchor"],
): RowSpaceBaseline {
  return { coldWindow: isColdWindowRowSpace(rows), anchor: anchor ?? null };
}

it("窗口态行号空间识别：首行为负数才是窗口态", () => {
  expect(isColdWindowRowSpace(rowsOf([-500_000, -499_999, -400_000]))).toBe(true);
  expect(isColdWindowRowSpace(rowsOf([1, 2, 3]))).toBe(false);
  // 空窗口身份未知：不得把「还没有行」当成窗口态。
  expect(isColdWindowRowSpace([])).toBe(false);
});

it("翻转判定：窗口态 ⇄ 权威全序需要重锚定；首帧 / 同空间 / 空窗口都不需要", () => {
  const windowRows = rowsOf([-900_000, -800_000]);
  const authoritativeRows = rowsOf([41, 42, 43]);
  expect(didRowIdentitySpaceFlip(baselineOf(windowRows), authoritativeRows)).toBe(true);
  expect(didRowIdentitySpaceFlip(baselineOf(authoritativeRows), windowRows)).toBe(true);
  expect(didRowIdentitySpaceFlip(baselineOf(windowRows), rowsOf([-700_000]))).toBe(false);
  expect(didRowIdentitySpaceFlip(baselineOf(authoritativeRows), rowsOf([50]))).toBe(false);
  // 基线缺席（首帧 / 切会话已重置）或新窗口为空：无从建立锚点，不重锚定。
  expect(didRowIdentitySpaceFlip(null, authoritativeRows)).toBe(false);
  expect(didRowIdentitySpaceFlip(baselineOf(windowRows), [])).toBe(false);
});

it("翻转重锚定：按 viewport 顶部 unit 的 key 求绝对 scrollTop", () => {
  // 翻转前：锚 unit 起点在 1000，用户视口顶部在该 unit 内偏下 120px。
  const anchor = { key: "turn-42", offsetTop: 120 };
  // 翻转后同一 turn 在新列表里的起点变成 6400 ⇒ 目标 scrollTop = 6400 - 120。
  expect(resolveRowSpaceFlipScrollTop(anchor, { start: 6400 })).toBe(6280);
  // 亚像素起点取整，避免写入非整数 scrollTop。
  expect(resolveRowSpaceFlipScrollTop(anchor, { start: 6400.6 })).toBe(6281);
  // 目标为负（锚 unit 在列表最前）时钳到 0，不能把内容顶出视口。
  expect(resolveRowSpaceFlipScrollTop({ key: "turn-1", offsetTop: 400 }, { start: 100 })).toBe(0);
});

it("翻转重锚定：锚 unit 不存在 / 数值不可信时返回 null（由调用方回到贴底语义）", () => {
  expect(resolveRowSpaceFlipScrollTop({ key: "turn-42", offsetTop: 120 }, null)).toBeNull();
  expect(resolveRowSpaceFlipScrollTop(null, { start: 6400 })).toBeNull();
  expect(
    resolveRowSpaceFlipScrollTop({ key: "turn-42", offsetTop: Number.NaN }, { start: 6400 }),
  ).toBeNull();
  expect(
    resolveRowSpaceFlipScrollTop({ key: "turn-42", offsetTop: 120 }, { start: Number.NaN }),
  ).toBeNull();
});
