# 工具卡「读取范围 + 截断种类」徽标（spec）

涉及包：`packages/ui`（唯一改动包）；标记字符串的源头在 `apps/zcode-cli` 的各 tool handler（只读引用，不改动）。

## 背景与问题

1. **同一文件看着像重复读**：Read 支持部分读取（`offset`/`limit` 行范围、PDF `pages`），CLI 侧还有
   token 预算触发的自动部分视图、`file_unchanged` 桩（再读直接返回 "Wasted call"）。但 UI 的
   Read 卡摘要（`buildReadSummary`）只取文件名与路径，把 `input.offset/limit` 与输出里的实际行范围
   全部丢弃；「查阅」组头的文件计数还按条目数累加（同一文件读两次 → 「2 文件」）。
   于是「整读 + 续读」「整读 + 未变更桩」在界面上长得一模一样，观感就是浪费。
2. **系统截断不可见**：工具输出有多条截断链路（Read token 上限、Grep/Glob 结果条数、
   resultBudget 序列化预算、输出转存 `<persisted-output>`、Bash display 截断、v4 投影层
   head+tail 预览），但除 TaskOutput/TaskStop/workflow 等少数卡已有各自的截断文案外，
   大多数卡片不显示「触发了哪种截断」。`raw.display.truncated` 与 `raw.outputTruncated`
   已到达 UI 却全仓无人消费。

## 设计决策

1. **纯 UI 层实现，零协议改动**。两条信号通道：
   - **输入参数**：`toolCall.input` 是结构化直传（`row.input`），Read 的 `offset/limit/pages`、
     Grep 的 `head_limit/offset` 现成可用，零解析。
   - **输出文本标记**：CLI handler 已把截断事实写进模型可见的输出文本（见下表），UI 按稳定
     子串检出。**标记字符串的单一所有者是 CLI handler**，UI 只读不写；两侧对应关系在单测
     文件头注释锚定，CLI 改文案会让单测先红。
   - 被否决的替代方案：扩展 v4 协议透传结构化截断（serialization/tool 级 flags）。更根治但要动
     shared + CLI 跨 workspace，且历史会话仍无数据；列入遗留另立任务。
2. **形态：范围入路径行，截断徽标放行尾**。行范围与路径同属「位置元数据」，并入 secondaryText
   作为并列元素（宿主容器 `inline-flex gap-2` 提供分隔：路径 `min-w-0 truncate` 可截断、
   范围 `shrink-0` 常显）；截断种类是状态性弱元数据，做独立 chip 挂 `ToolLayout` 状态区
   （statusLabel 左侧），外包 Tooltip 给一句话细节。范围样式与路径同级（`text-foreground-subtlest`）。
3. **徽标中性色**（复用 `sourceLabel` chip 的 border/background/subtlest 三件套 + `text-ui-xs`），
   不用 warning/destructive——DESIGN.md 规定语义色只留给真正的语义状态，截断是弱元数据。
4. **单卡最多一枚徽标**，8 类按固定优先级取第一个命中（见行为表）。截断是例外状态，多枚并列
   会喧宾夺主；优先级把「最能解释用户疑惑的」排前面（未变更 > 部分视图 > 结果超限）。
5. **失败语义：解析不到就不显示**。标记子串匹配不到 → 返回 null，不猜测、不兜底显示通用徽标。
   历史会话输出同样携带标记（文本已落库），因此天然覆盖历史。
6. **Read 范围以输出为准、输入兜底**：输出有 `Showing a partial view of lines X-Y of Z` 标记时，
   X–Y 是实际返回的行范围（token 上限可能把 `limit` 再截短），优先采用；否则用 `input.offset/limit`
   推算；两者皆无 → 不显示（整读）。

## 行为

### 截断徽标（优先级从上到下，命中即止）

| #   | kind               | 徽标 zh / en         | 检测条件（输出文本子串 / 结构化字段）                                                      |
| --- | ------------------ | -------------------- | ------------------------------------------------------------------------------------------ |
| 1   | `unchanged`        | 未变更 / Unchanged   | 含 `Wasted call — file unchanged`（read.ts FILE_UNCHANGED_STUB）                           |
| 2   | `partialView`      | 部分视图 / Partial   | 含 `Showing a partial view of lines`（read-text.ts）                                       |
| 3   | `resultsTruncated` | 结果超限 / Capped    | 含 `with pagination = limit:` / `Found N files limit:`（真截断）/ `(Results are truncated` |
| 4   | `webfetch`         | 内容截断 / Truncated | 含 `[WebFetch content truncated`（webfetch-content.ts）                                    |
| 5   | `persisted`        | 已转存 / Saved       | 含 `<persisted-output>`（result-persistence-format.ts）                                    |
| 6   | `budget`           | 超预算 / Budget      | 含 `[Tool output truncated by resultBudget`（result-serialization.ts）                     |
| 7   | `displayTruncated` | 输出截断 / Truncated | `raw.display?.truncated === true`（duck-typed，Bash 等 display payload）                   |
| 8   | `previewHeadTail`  | 仅头尾 / Preview     | `raw.outputTruncated` 存在（v4 投影层 32K head+tail）                                      |

每个 kind 配 zh/en 双语：徽标短文案（≤4 字）+ Tooltip 一句话细节；`resultsTruncated` 的 Tooltip
尽力从标记解析条数（`limit: N`），解析不到用通用文案。

### Read 卡

- secondaryText = 文件路径 + 范围（并列元素，见设计决策 2），范围三选一：
  1. 输出 partial-view 标记 → `第 X–Y 行`（实际范围，覆盖 input）；
  2. `input.pages`（PDF）→ `页 {pages}`；
  3. `input.offset/limit`（1-based）推算：`offset>1 & limit` → `第 offset–offset+limit-1 行`；
     `offset>1` 无 limit → `第 offset 行起`；仅 limit → `前 limit 行`；`offset≤1` 无 limit → 不显示。
- noticeChip 走优先级表。
- Explore 组内的子 Read 行同样生效（展开态行走各 renderer；收起态 childSummaries 同步带范围）。

### Search（Grep/Glob）卡

- 新增 secondaryText：`input.head_limit` → `前 N 条`；`input.offset > 0` → `跳过 N 条`；
  两者可组合。主文本仍是一句完整摘要（既有定位不变），secondary 只挂弱元数据。
- noticeChip 走优先级表（Grep/Glob 截断命中 #3）。

### Execute（Bash）卡与 Fallback 卡

- noticeChip 走优先级表。Fallback 使所有未单独定制的工具获得通用四类
  （budget / persisted / displayTruncated / previewHeadTail）。

### Explore 组

- **文件计数按路径去重**：同一 `filePath` 读多次只计 1（组头/摘要「N 文件」）；
  search/list 桶保持按条计数（每个查询是独立动作，不聚合）。

### 状态矩阵

| 状态           | 行为                                                                      |
| -------------- | ------------------------------------------------------------------------- |
| 整读未截断     | 无范围后缀、无徽标，与现状一致                                            |
| 输入流式中     | `offset/limit` 流到就显示（渐进出现，永不显示错值）；output 未到 → 无徽标 |
| 运行中         | 同上：范围可先出现，徽标等 output                                         |
| 部分视图       | 范围以标记 X–Y 为准；徽标「部分视图」                                     |
| file_unchanged | 徽标「未变更」（解释"重复读"观感）                                        |
| 失败           | statusLabel/errorText 照旧；通常无 output → 无徽标                        |
| 移动端 / 窄屏  | 徽标在状态区随行收缩，文案 ≤4 字不换行                                    |

## 所有权与不变式

- **标记字符串的所有者是 `apps/zcode-cli` 各 handler**（read / read-text / glob / grep /
  webfetch-content / result-serialization / result-persistence-format）。UI 的
  `truncationNotice.ts` 只读匹配；对应关系由 `packages/ui/test/truncationNotice.test.ts`
  文件头注释锚定到 CLI 源文件，防两侧漂移。
- **范围与徽标都是纯展示**：不产生状态、不发服务调用、不改协议、不落盘。
- **单卡最多一枚徽标**；解析失败返回 null，不猜。
- 不改动 task-output / task-stop / workflow 卡已有的截断文案（功能等价，视觉统一列入遗留）。

## 失败语义

- 标记子串匹配不到 → `detectTruncationNotice` 返回 `null`，卡片不渲染徽标（宁缺毋滥）。
- `raw.display` 非对象或无 `truncated` 字段 → 跳过该项，继续按优先级查后续项。
- Tooltip 文案 key 缺失时回退为徽标短文案本身（不渲染空 Tooltip）。

## 迁移边界

- 历史会话：输出文本已落库，标记检出同样生效；`raw.outputTruncated`/`display` 字段历史 row
  携带即显示，缺失不补。
- 不动协议、不动 CLI、不引入第二套检测路径；协议级结构化透传（遗留项）落地时，替换
  `detectTruncationNotice` 的内部信号源即可，组件与槽位不动。
