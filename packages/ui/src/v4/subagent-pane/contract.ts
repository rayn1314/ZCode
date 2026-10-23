/**
 * subagent-pane-ui 对外契约：调用方要想正确调用就必须知道的一切都写在这里；其余对外不可见。
 *
 * 模块意图：子代理在**左栏与会话面板**这两处的呈现与打开入口——父条目下方（父条目选中时）的
 * 子区块、父条目未选中时的计数角标、会话面板的形态（能力位）、「点击 → 打开子会话 / 子代理目录」，
 * 以及把本机权威的子代理配置复制给 desktop-attached 远端 Host。
 *
 * 数据两条来源、各归其主，本模块只合并/投影、不取数、不复制状态：
 * - `running`：父会话 conversation 权威投影 `snapshot.subagents.running`（运行的唯一权威）；
 * - `endedItems` / `endedTotal`：既有分页查询 `session/subagents` 的 ended 页 + 投影总数。
 *
 * 规格：apps/zcode-cli/packages/core/spec/subagent-session-as-first-class.md 的
 * 「左栏任务列表：层级态」与「侧栏子会话面板」两节；行身份空间另有
 * apps/zcode-cli/packages/bootstrap/spec/cold-open-window-first.md §A/B。
 */
import type { SubagentLifecycleStatus } from "@/v4/subagentLifecycleStatus.js";

export type { SubagentSubBlockModel, SubagentSubBlockRow } from "@/v4/subagentSubBlockModel.js";
export { buildSubagentSubBlockRows } from "@/v4/subagentSubBlockModel.js";

export type { SubagentLifecycleStatus } from "@/v4/subagentLifecycleStatus.js";

export type { SessionPaneCapabilities, SessionPaneShape } from "@/v4/sessionPaneCapabilities.js";
export { resolveSessionPaneCapabilities } from "@/v4/sessionPaneCapabilities.js";

export type {
  RowSpaceBaseline,
  RowSpaceFlipAnchor,
  RowSpaceFlipTarget,
} from "@/v4/conversationRowIdentitySpace.js";
export {
  didRowIdentitySpaceFlip,
  isColdWindowRowSpace,
  resolveRowSpaceFlipScrollTop,
} from "@/v4/conversationRowIdentitySpace.js";

export type {
  SubagentDirectoryOpenTarget,
  SubagentOpenHandlers,
  SubagentSessionOpenTarget,
} from "@/v4/subagentOpenContext.js";
export { SubagentOpenProvider, useSubagentOpen } from "@/v4/subagentOpenContext.js";

/**
 * `buildSubagentSubBlockRows` 的判定顺序（纯函数：无 IO、无 React、同入参必得同结果）：
 * 1. 运行中按 `startedAt` 倒序排在最前，**不受 `limit` 限制**；
 * 2. 已结束先滤掉与运行中重复的 `childSessionId`（投影脉动点比 ended 分页新，同一子会话短暂
 *    同时出现在两处时以投影为准，否则区块出现重复行与重复 React key），再倒序取 `limit` 条；
 * 3. `hiddenEndedCount = endedTotal - 已显示的已结束条数`（分页条数可能少于总数，拿条数当总数
 *    会把「还有 N 个」算小）；0 表示不渲染那一行。
 * 缺 `startedAt` 的历史行排最后——「没有时间」不等于「很久以前」。
 */

/**
 * `resolveSessionPaneCapabilities`：形态 → 13 个能力位的**唯一真相源**（`readOnly` 也是其中
 * 一列，`shape === "observe"`）。四种形态：`interactive`（默认）/ `observe`（只读 workspace、
 * workflow actor、只读 transcript）/ `selectionSideChat`（框选副屏）/ `subagentChild`（子代理
 * 子会话，本地与远端一视同仁）。
 *
 * 前置：调用方先定形态，再读能力位；不要拿单个布尔（旧的 `readOnly`）临时拼第三种组合——
 * 子会话要的组合正是加第四个布尔就会互相打架的那一种。
 * 后置：同一形态恒返回同一份语义表；新增能力位必须在四个形态里都给值（类型强制，漏一列是
 * 编译错误而不是静默通过）。别把 `goalPanel`（展示）并进 `goalCommands`（控制入口）：
 * `observe` 的 goal 进度本来就可见，只是没有控制入口。
 */

/**
 * 行身份空间翻转（冷打开窗口态 ⇄ 权威全序）：本模块只提供判定与目标值计算，读写 measurement
 * 与 scrollTop 由调用方负责，因此这组函数无 DOM/CSS 依赖。窗口态的标记是**首行 rowId 为负**；
 * 空窗口不算窗口态。
 *
 * - `didRowIdentitySpaceFlip`：只有「基线存在且新旧两侧都有行」才算翻转；首帧 / 切会话 / 空窗口
 *   一律 false——那时没有可比空间，谈不上翻转。
 * - `resolveRowSpaceFlipScrollTop`：返回 null（无锚点 / key 不在新列表 / 数值不可信）时，调用方
 *   必须回到「打开会话贴底」的语义，绝不能沿用旧空间的量做补偿：按错误的行起点算出的平移会让
 *   视口突然跳到很远的位置。负数目标钳到 0。
 */

/** `SubagentSubBlock` 的 props 契约（实现在 `SubagentSubBlock.tsx`）。 */
export interface SubagentSubBlockProps {
  /** 父条目的 workspace 坐标：左栏是跨 workspace 混排视图，壳层无从推断。 */
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
}

/**
 * `SubagentStatusIcon` 的 props 契约（实现在 `SubagentStatusIcon.tsx`）。
 *
 * 前置：`status` 取七态之一（运行三态 + 结束四态），图标与文案复用 `subagentDirectory.status.*`；
 * 不新造第二套状态语汇、不新增取值、不单靠颜色区分。
 * 后置：`label` 只在「图标是唯一状态指示」的场合（左栏子区块右侧）传；会话面板那里状态词已写在
 * 标题旁，保持 `aria-hidden`，不要重复朗读。
 */
export interface SubagentStatusIconProps {
  status: SubagentLifecycleStatus;
  className?: string;
  label?: string;
}

/**
 * 远端复制（模块的 desktop host 半边，实现在 `packages/desktop/src/host/remoteSubagentConfig.ts`）。
 * 契约只能在这里用文字钉住：ui 工程没有解析 `@desktop/*` 的 path（ui/tsconfig.json 只声明 `@/*`），
 * 从 ui 源码里 re-export 会让 `pnpm typecheck` 解析失败，因此不在此处做类型出口。
 *
 * `pushSubagentConfigToRemoteHosts`（顺序相关，不是幂等事务）：
 * 前置：`connections` 是当前所有 desktop-attached 远端连接；本机是配置权威，读本机失败只调
 * `onError` 且不产生 rejection（调用点多为「保存后顺手广播」的 fire-and-forget）。
 * 后置：跳过 `kind === "server"` 的连接（standalone server 有自己的设置权威，不推）；每个连接按
 * `replaceSubagentState` → `replaceUserAgentFiles` → `reloadSubagents` 各一次——重载按磁盘整份
 * 重解析，分两次发只会让中间态多一次无意义重读。state 写失败即放弃该连接（不留下半份副本）；
 * 文件写失败或旧对端不认 `replaceUserAgentFiles` 时只降级那一步，state 复制与重载照常。
 * 各连接并行推进，单个连接失败只上报，不影响其它连接（spec `subagent-settings-sync.md` D1）。
 */
