// 虚拟滚动核心：v4 timeline 底部锚定状态机（纯函数，无 DOM/React 依赖）。
//
// 语义（scrollAnchor）：
// - 用户位于底部 → following=true，新内容（新行 / 流式 delta / 测高变化）自动贴底；
// - 用户上滚离底 → following=false，流式增量不得拉回阅读位置，出现「回到底部」按钮；
// - 用户手动滚回底部（或点按钮）→ 恢复跟随。
//
// following 表达用户滚动权，不是瞬时几何快照：只有真实用户滚动输入可以改变它；
// 程序化贴底、terminal 折叠和 virtualizer 测高补偿产生的 scroll 事件只更新几何账目。
//

/** 离底判定容差：小于该距离视为「在底部」。取值覆盖亚像素滚动与最后一行 padding。 */
const BOTTOM_ANCHOR_EPSILON_PX = 48;

interface TimelineScrollMetrics {
  /** 滚动容器 scrollTop。 */
  scrollTop: number;
  /** 滚动容器可视高度（clientHeight）。 */
  viewportHeight: number;
  /** 内容总高度（scrollHeight）。 */
  contentHeight: number;
}

/** 距底部的剩余可滚动距离（内容不足一屏时为 0）。 */
export function distanceToBottom(metrics: TimelineScrollMetrics): number {
  return Math.max(0, metrics.contentHeight - metrics.viewportHeight - metrics.scrollTop);
}

export function isAtBottom(
  metrics: TimelineScrollMetrics,
  epsilonPx: number = BOTTOM_ANCHOR_EPSILON_PX,
): boolean {
  return distanceToBottom(metrics) <= epsilonPx;
}

/**
 * scroll 事件后的跟随态。规则：落点在底部 ⇔ 跟随。
 * 覆盖三种来源且无需区分：用户上滚（离底 → 解除）、用户滚回（贴底 → 恢复）、
 * 程序化贴底（落点即底部 → 保持）。
 */
function nextFollowingAfterScroll(
  metrics: TimelineScrollMetrics,
  epsilonPx: number = BOTTOM_ANCHOR_EPSILON_PX,
): boolean {
  return isAtBottom(metrics, epsilonPx);
}

type TimelineScrollEventSource = "user" | "programmatic" | "layout";

/**
 * scroll 事件后的滚动权裁决。布局/程序化 scroll 不得改变用户意图；只有用户输入
 * 才按最终落点决定是否跟随。
 */
export function resolveFollowingAfterScroll(input: {
  following: boolean;
  metrics: TimelineScrollMetrics;
  source: TimelineScrollEventSource;
  epsilonPx?: number;
}): boolean {
  if (input.source !== "user") return input.following;
  return nextFollowingAfterScroll(input.metrics, input.epsilonPx);
}

/**
 * 内容变化（新行追加 / 流式 delta 撑高 / 动态测高修正）后的动作：
 * 跟随中 → 贴底；已解除 → 保持阅读位置（绝不拉回）。
 */
export function anchorActionAfterContentChange(
  following: boolean,
  contentWidthChanging: boolean = false,
): "stickToBottom" | "hold" {
  return following && !contentWidthChanging ? "stickToBottom" : "hold";
}

/**
 * virtualizer 动态测高后的滚动补偿裁决。
 *
 * 判定对齐 @tanstack/virtual-core 的默认谓词（`item.start < scrollOffset`）：只要行的
 * 起点在视口顶之上（含正跨过视口顶边的行）就必须补偿，否则行高变化会把视口内容整体
 * 推移。历史实现只补偿「整行完全在视口上方」（itemEnd <= scrollTop），漏掉跨顶边行：
 * 会话切换后全窗口处于估计高度重测期，用户首次上滑解除跟随，此后跨顶边行的测高增量
 * 不补偿，视口内容被整体推移，形成「轻轻一滚就跑到很上面」再自行收敛的跳变。
 * 宽度 resize 会让多条消息在相邻帧分批测高；此时逐条补偿 scrollTop 会形成可见抖动。
 */
export function shouldAdjustVirtualizerForItemSizeChange(input: {
  following: boolean;
  suppressAdjustment: boolean;
  contentWidthChanging: boolean;
  itemStart: number;
  scrollTop: number;
}): boolean {
  if (input.suppressAdjustment || input.following || input.contentWidthChanging) {
    return false;
  }
  return input.itemStart < input.scrollTop;
}

/** 未观察滚动的判定容差：小于该值的 scrollTop 回退视为亚像素抖动，不算用户上滚。 */
const UNOBSERVED_SCROLL_EPSILON_PX = 2;

export type TimelineUserScrollIntent = "none" | "awayFromBottom" | "towardBottom" | "unknown";

/** wheel 的 deltaY 与 scrollTop 同向：负值阅读更早内容，正值靠近底部。 */
export function timelineWheelScrollIntent(deltaY: number): TimelineUserScrollIntent {
  if (deltaY < 0) return "awayFromBottom";
  if (deltaY > 0) return "towardBottom";
  return "none";
}

/** touch 手指位移与 scrollTop 反向：手指下移表示阅读更早内容。 */
export function timelineTouchScrollIntent(
  previousClientY: number,
  nextClientY: number,
): TimelineUserScrollIntent {
  if (nextClientY > previousClientY) return "awayFromBottom";
  if (nextClientY < previousClientY) return "towardBottom";
  return "none";
}

/** 键盘滚动意图；输入控件内的光标按键不属于 timeline 滚动。 */
export function timelineKeyboardScrollIntent(input: {
  key: string;
  shiftKey: boolean;
  editableTarget: boolean;
}): TimelineUserScrollIntent {
  if (input.editableTarget) return "none";
  if (input.key === "ArrowUp" || input.key === "PageUp" || input.key === "Home") {
    return "awayFromBottom";
  }
  if (input.key === "ArrowDown" || input.key === "PageDown" || input.key === "End") {
    return "towardBottom";
  }
  if (input.key === " ") {
    return input.shiftKey ? "awayFromBottom" : "towardBottom";
  }
  return "none";
}

/**
 * 内容变化 commit 贴底前，对账用户滚动意图。
 *
 * 跟随态由 scroll 事件驱动，但 scroll 事件在滚动发生后的下一渲染帧才派发：
 * 用户上滚（wheel）或测试程序化 scrollTop 赋值之后、事件派发之前，若恰好落进一个
 * totalSize/rowCount 变化的 React commit（流式 delta、ResizeObserver 测高修正、
 * composer 尺寸变化引起的窗口重算），贴底 effect 会拿着**过期的 following=true**
 * 把 scrollTop 拽回底部，且回弹落点让随后的 scroll 事件把跟随判回 true——
 * 用户/测试的上滚被整体吞掉（“resize/测量 commit 夺走滚动权”）。
 *
 * 对账规则（在贴底动作之前执行，输入为 commit 时刻的实时指标）：
 * 1. 明确向上滚动 → 立即解除跟随，同帧 terminal/layout commit 也必须让位；
 * 2. 没有用户输入 → 原样保持 following，virtualizer/折叠导致的 scrollTop 回退不算上滚；
 * 3. 方向未知或向下的用户输入 → 落点在底则恢复跟随，明显回退则解除，其余保持。
 */
export function reconcileFollowingForContentAnchor(input: {
  /** 当前跟随态（scroll 事件驱动的既有值）。 */
  following: boolean;
  /** commit 时刻（贴底动作前）的实时滚动指标。 */
  metrics: TimelineScrollMetrics;
  /** 组件最近一次「已账目」的 scrollTop（scroll 事件读取值或程序化写入后的回读值）。 */
  lastObservedScrollTop: number;
  /** 当前内容 commit 前捕获到的用户滚动意图；省略时按旧的未知来源对账。 */
  userScrollIntent?: TimelineUserScrollIntent;
  bottomEpsilonPx?: number;
  scrollEpsilonPx?: number;
}): boolean {
  const userScrollIntent = input.userScrollIntent ?? "unknown";
  if (userScrollIntent === "awayFromBottom") return false;
  if (userScrollIntent === "none") return input.following;
  if (isAtBottom(input.metrics, input.bottomEpsilonPx ?? BOTTOM_ANCHOR_EPSILON_PX)) {
    return true;
  }
  const unobservedUpscroll =
    input.metrics.scrollTop <
    input.lastObservedScrollTop - (input.scrollEpsilonPx ?? UNOBSERVED_SCROLL_EPSILON_PX);
  if (unobservedUpscroll) {
    return false;
  }
  return input.following;
}

/** 「回到底部」按钮可见性：仅在解除跟随且确实存在内容时展示。 */
export function shouldShowBackToBottom(following: boolean, rowCount: number): boolean {
  return !following && rowCount > 0;
}

/** 会话切换 / 首次绑定：重置为跟随（打开会话定位到最新消息）。 */
export function initialFollowing(): boolean {
  return true;
}

// ── loadOlder：prepend 滚动锚定（虚拟滚动前插的经典坑）──
//
// 语义：向窗口顶部前插历史行时，用户正在读的行（锚点）在视口中的位置不得跳动。
// 恢复方式是绝对目标而非增量：scrollTop' = next.start - previous.offsetTop。
// - previous.offsetTop 是锚 unit「记录时刻」的视口偏移（measurement.start - 当时的
//   scrollTop），来源有两种：loadOlder 触发瞬间（精确路径），或上一 commit 末的
//   常规基线（兜底路径）；
// - next.start 是锚 unit 在本 commit 的 measurement 起点。
// 为什么用绝对目标：前插 commit 与同帧落地的测高修正都会改变锚 start 与 scrollTop。
// 增量式平移（如旧的 nextTotalSize - prevTotalSize）在同帧测高先于平移落地时，会把
// 该测高增量重复计入；绝对目标始终对齐「锚 unit 的当前 start」，测高先于或后于本
// 函数落地都只计一次。

export interface PrependVirtualAnchor {
  key: string;
  /** 锚点 measurement 起点相对视口顶部的偏移。 */
  offsetTop: number;
  start: number;
}

/**
 * 同一稳定 key 在 prepend 后需要施加的 scrollTop 修正量。
 *
 * 触发 loadOlder 到 rows 提交之间，恢复布局或 virtualizer 可能先改写
 * scrollTop；只叠加 measurement.start 的差值会把这段中间位移重复计入。以记录时刻
 * 保存的视口偏移计算绝对目标，再减实时 scrollTop，才能稳定恢复原阅读位置。
 */
export function prependVirtualAnchorAdjustment(
  previous: PrependVirtualAnchor,
  next: PrependVirtualAnchor,
  currentScrollTop: number,
): number | null {
  if (previous.key !== next.key) return null;
  if (
    !Number.isFinite(previous.offsetTop) ||
    !Number.isFinite(next.start) ||
    !Number.isFinite(currentScrollTop)
  ) {
    return null;
  }
  return next.start - previous.offsetTop - currentScrollTop;
}

/** 顶部触发阈值：距顶小于该距离视为「到顶」，自动拉取更早一窗。 */
const LOAD_OLDER_TRIGGER_PX = 64;

/** 提前两个视口补页，网络与渲染应在用户抵达窗口边界前完成。 */
const LOAD_OLDER_PREFETCH_VIEWPORTS = 2;

export function historyPrefetchTriggerPx(viewportHeight: number): number {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) {
    return LOAD_OLDER_TRIGGER_PX;
  }
  return Math.max(LOAD_OLDER_TRIGGER_PX, viewportHeight * LOAD_OLDER_PREFETCH_VIEWPORTS);
}

/** scroll 事件是否应触发 loadOlder（到顶 + 可拉 + 非在途）。 */
export function shouldTriggerLoadOlder(input: {
  scrollTop: number;
  canLoadOlder: boolean;
  loadingOlder: boolean;
  triggerPx?: number;
}): boolean {
  return (
    input.canLoadOlder &&
    !input.loadingOlder &&
    input.scrollTop <= (input.triggerPx ?? LOAD_OLDER_TRIGGER_PX)
  );
}
