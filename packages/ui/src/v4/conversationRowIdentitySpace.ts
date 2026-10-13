// 行身份空间（rowId space）识别与翻转重锚定：纯函数，无 DOM/React 依赖。
//
// 依据（apps/zcode-cli/packages/bootstrap/spec/cold-open-window-first.md §A）：冷打开未常驻
// 会话时，CLI 先推一份「尾部窗口」预览 snapshot，它的行号在**负数空间**（冷窗口行号只由
// 「消息序号 + 消息内行序」决定，不会与权威全序 1..N 撞号，也天然成为窗口态的标记）；
// 后台补全完成后，同一订阅收到权威 snapshot，行号整体换成全序。客户端因此只凭「行窗口
// 首行 rowId 是否为负数」就能判定自己拿的是窗口态。
//
// 为什么需要显式处理翻转：窗口态与权威态的行身份、行数、estimated/measured 高度都不同，
// 而虚拟列表按 stable key（turnId）维护测高与起点。翻转 commit 上若沿用旧空间的量做
// prepend/测高补偿，会按错误的行起点算出错误平移，表现为用户上翻几下后视口突然跳到很远
// 的位置。正确做法是：整份作废旧空间派生状态，再按「视口顶部所在 unit 的 turnId」重锚定——
// 该 turn 在新列表里的 measurement.start 减去翻转前记录的视口内偏移，就是新的 scrollTop。
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

/** 行窗口是否处于冷打开窗口态的行号空间（负数空间，见文件头）。空窗口不算。 */
export function isColdWindowRowSpace(rows: readonly ConversationRow[]): boolean {
  const first = rows[0];
  return first !== undefined && first.rowId < 0;
}

/**
 * 翻转前视口顶部 unit 的锚点：key 是稳定 turn key（turnId），offsetTop 是该 unit 起点
 * 相对视口顶部的偏移（记录时刻 measurement.start - scrollTop）。行高在两次 commit 之间
 * 可能被重测，因此只保存偏移，不保存绝对 scrollTop。
 */
export interface RowSpaceFlipAnchor {
  key: string;
  offsetTop: number;
}

/** 每 commit 末记录的行空间基线；`anchor` 为 null 表示当时没有可用的视口顶部 unit。 */
export interface RowSpaceBaseline {
  coldWindow: boolean;
  anchor: RowSpaceFlipAnchor | null;
}

/**
 * 本 commit 是否发生行身份空间翻转（即需要按 turn key 重锚定）。基线缺席（首帧 /
 * 切会话）或任一侧没有行时都不算翻转。
 */
export function didRowIdentitySpaceFlip(
  baseline: RowSpaceBaseline | null,
  rows: readonly ConversationRow[],
): boolean {
  if (baseline === null || rows.length === 0) return false;
  return baseline.coldWindow !== isColdWindowRowSpace(rows);
}

/** 新空间里按 key 找到的 measurement 起点；找不到（key 不在权威尾窗中）传 null。 */
export interface RowSpaceFlipTarget {
  start: number;
}

/**
 * 翻转后要写入的 scrollTop（绝对目标）：`新 measurement.start - 翻转前视口内偏移`。
 *
 * 返回 null 表示无法重锚定（无锚点 / key 在新列表里不存在 / 数值不可信）：调用方应保持
 * 「打开会话」的贴底语义——权威尾窗就是最新内容。负数目标钳到 0，避免把内容顶出视口。
 */
export function resolveRowSpaceFlipScrollTop(
  anchor: RowSpaceFlipAnchor | null,
  target: RowSpaceFlipTarget | null,
): number | null {
  if (!anchor || !target) return null;
  if (!Number.isFinite(anchor.offsetTop) || !Number.isFinite(target.start)) return null;
  return Math.max(0, Math.round(target.start - anchor.offsetTop));
}
