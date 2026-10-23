/**
 * tool-partial-read-notice 对外契约：调用方要想正确调用就必须知道的一切都写在这里；其余对外不可见。
 *
 * 模块意图：把「这次读取/搜索看了哪一段」与「输出被哪条链路截断」这两件事，从工具调用的
 * `input` 与已落库的输出文本里读出来，供 Read / Search（Grep、Glob）/ Execute / Fallback
 * 四种卡片渲染次要文本与状态区徽标。
 *
 * 全部是纯展示推导：不产生状态、不发服务调用、不改协议、不落盘、不等任何持久化（同一次
 * 调用给同样的入参必得同样结果，天然幂等）。入参是已到达 UI 的调用快照，因此历史会话同样
 * 生效——输出文本早就在库里。
 *
 * 标记字符串的所有者是 apps/zcode-cli 各 tool handler，本模块只做只读子串匹配；两侧对应
 * 关系由 packages/ui/test/truncationNotice.test.ts 的文件头锚点表钉住（CLI 改文案先让那份
 * 测试变红，宁可红在测试也不要静默丢徽标）。
 *
 * 规格：packages/ui/spec/tool-call-range-and-truncation.md。
 */
import type { TruncationNotice } from "@/ToolCallBlocks/truncationNotice.js";

export type {
  ReadRange,
  SearchRange,
  TruncationNotice,
  TruncationNoticeKind,
} from "@/ToolCallBlocks/truncationNotice.js";
export {
  detectTruncationNotice,
  formatReadRangeLabel,
  formatSearchRangeLabel,
  resolveOutputText,
  resolveReadRange,
  resolveSearchRange,
} from "@/ToolCallBlocks/truncationNotice.js";

/**
 * 注入的文案函数（调用方传 `intl.formatMessage`）。之所以注入而不是 import intl：
 * 让上面所有推导保持纯函数、可脱离 React 单测。
 */
export type TruncationNoticeFormatMessage = (
  id: string,
  values?: Record<string, string | number>,
) => string;

/**
 * `TruncationNoticeChip` 的 props 契约（实现在 `TruncationNoticeChip.tsx`）。
 *
 * 前置：`notice` 必须是 `detectTruncationNotice` 的返回值——组件不做检测、不做兜底，
 * 也不会因为文案 key 缺失就换一种徽标；缺 key 时 Tooltip 回退成徽标短文案本身（不渲染空提示）。
 * 后置：单卡最多渲染这一枚徽标，中性色弱元数据，不改动卡片的状态语义。
 */
export interface TruncationNoticeChipProps {
  notice: TruncationNotice;
}

/**
 * 判定顺序（逐函数的前置/后置条件写在实现文件里，这里只列调用方必须知道的部分）：
 *
 * - `resolveOutputText`：v4 输出是字符串、旧快照是 record（`raw.rawOutput.text|output|content`）；
 *   两条通道都收，都拿不到返回空串。纯读取，不改任何写入方。
 * - `detectTruncationNotice`：**单卡最多一枚徽标**，按固定优先级取第一个命中
 *   （未变更 > 部分视图 > 结果超限 > 内容截断 > 已转存 > 超预算 > 输出截断 > 仅头尾）；
 *   全部未命中返回 `null`——不猜、也不兜底显示通用徽标。
 * - `resolveReadRange`：范围**以输出里的 partial-view 标记为准**（token 上限可能把 `limit` 再
 *   截短），否则回落到 `input.pages` / `input.offset`+`limit`；两者皆无返回 `null`
 *   （= 整读，卡片不显示范围）。
 * - `resolveSearchRange`：`head_limit=0` 是 CLI 侧的「无限制」语义、`offset=0` 是缺省，
 *   两者都不当用户意图显示；都缺省时返回 `null`。
 * - `formatReadRangeLabel` / `formatSearchRangeLabel`：只把范围结构翻成文案 key + 取值，
 *   不判断该不该显示（「该不该显示」由上一步的 `null` 语义决定）。
 */
