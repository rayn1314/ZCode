# 用量账本（Usage Ledger）

涉及包：`packages/services`（主责）、`packages/shared`（协议）、`packages/ui`（面板）、`packages/client`（远端代理声明）、`packages/desktop`（host 进程承载）。

## 背景与问题

自建版原有的「应用用量」统计只覆盖 host 自己的数据根，看不到 WSL 内会话、官方版数据根与其它自建身份的数据；外部工具「ZCode 用量账本」（Python 单文件版）证明了多数据源聚合的价值，但不属于产品本体。本功能把工具的读取能力与信息功能合并进设置页使用统计，作为第三个 tab「用量账本」，首个落地的能力就是官方版统计不到 WSL 的修正。

「应用用量」面板本轮零改动；热力图/连续天数/工具统计的多源化合并留待二期。

## 数据链路与所有权

```
LedgerPanel (ui/settings/usage-stats/ledger/)
  → useLedgerStats (ui/hooks)
  → IUsageLedgerService（services，ServiceChannels.UsageLedger = "usage-ledger"）
  → host 进程 createUsageLedgerService（仅 packages/services/src/node.ts 注册）
  → LedgerReader（ledgerReader.ts：编排；ledgerRoots.ts：根探测）
      ├─ Windows 根：node:sqlite 只读直开 <root>/cli/db/db.sqlite（ledgerAggregate.ts）
      └─ WSL 根（仅 win32）：ledgerWsl.ts 探测 + 送内嵌 Python（ledgerDumpScript.ts）进 WSL 执行，
         stdout 回传单源聚合 JSON
  → mergeLedgerPayloads（ledgerMerge.ts）多源合并
  → calcLedgerCost（ledgerPrices.ts）逐模型计价
```

- 唯一状态所有者：host 侧 `LedgerReader`。UI 无本地聚合状态，只有筛选偏好（localStorage）。
- 服务注册仅桌面本地 host（node.ts）；远端 workspace 不注册，`accessor.usageLedgerService` 为可选字段，`remoteServiceAccess` 上的 ProxyChannel 调用会 reject——UI 捕获后展示「当前环境不支持」空态（降级语义，不是错误）。

## 数据根与来源 key

| 来源           | key 格式              |
| -------------- | --------------------- |
| Windows 官方根 | `windows`             |
| Windows 自建根 | `windows@<身份>`      |
| WSL 官方根     | `wsl:<发行版>`        |
| WSL 自建根     | `wsl:<发行版>@<身份>` |

- 自建根判定：目录末段 `.zcode-<身份>`（ledgerRoots.ts `classifyLedgerRoot`）。
- 官方根候选链：`ZCODE_HOME` → `~/.zcode` → `~/.config/zcode` → `%APPDATA%/zcode`；自建根扫 home 一层 `.zcode-*`（TTL 30s）；WSL 根用 `wsl.exe`（Running 发行版 + find 探测，TTL 300s；本次未确认到的已知源按 stale 保留灰显 30min）。
- 主源 = host 自己的数据根，key 去重时后来者加 `#N` 后缀（dev 环境主源可能被归为 official，与真实官方根撞 key）。
- 供应商显示名统一读各数据根自己的 `v2/provider_config.json`（ledgerProviderNames.ts），跨根筛选按显示名成立；**只读 providerId/providerName 两个字段，绝不读取、存储或输出任何凭据字段**。

## 口径资产（与工具版本一致，两侧同轴）

1. **token 包含关系**：cacheRead ⊂ input、reasoning ⊂ output；任何 token 合计只用 `input + output`。
2. **费用**：逐模型计价再汇总 `(input − cacheRead)/1e6*pIn + output/1e6*pOut + cacheRead/1e6*pCache`——`input_tokens` 本就含 cacheRead（AI SDK 归一化口径），必须先从输入扣掉命中部分再乘输入价；否则命中部分按未命中价计一遍、再按缓存价计一遍，高命中率（98%）场景费用虚高数十倍（2026-10-09 修复：xin × deepseek-v4-1-flash 曾从 ~$104 显示成 $7,069）。今天/本月/每日/模型/Agent/会话各视图都按 (维度, 模型) 分组取出后折叠，费用才能按维度归并。未定价模型显式记入 `unpricedCalls/unpricedModelIds`，不静默归零。
3. **合并**（ledgerMerge.ts）：计数求和；均值（耗时/TTFT）按调用数加权；recent 重排后截 **500 条**；sessions 重排后再截 **500 个顶层会话**（单源 200）——这是 UI 翻页的数据池上限（单源 recent SQL 500），明细表分页展示（每页 20/50/100/200 可调、偏好记忆），不再一屏平铺硬滚；sessions 的配额按**顶层会话数**计且**必须保父链完整**（不允许子行孤立出现，见「会话层级」）；**费用只累加非 null**——某源没有价格表时混入 0 会让总数凭空少一截。
4. **时间分桶**：全部参数化整数算术 `(COALESCE(started_at,0)+tzOffsetMs)/86400000`，不用 strftime/date 修饰符；WSL 侧 Python 用同一偏移（host 下发 `tzOffsetMinutes`），跨环境同一条时间轴。
5. **范围**：today=本地今日 0 点起；7d/30d 含今日；all 上界取 now（`started_at <= NULL` 恒假，不能留 null）；custom 起止可交换，止日为次日 0 点 -1。
6. **模型 × 供应商明细**：models 按 (model_id, provider_id) 分组聚合，UI「模型与供应商」表整表分页展示（费用占比 = 单行费用 / 已计价费用合计，未定价行显示「--」），还原原 zcode-usage 工具页脚 tabs 区的模型表。**会话层级只改会话视图**：models / agents / daily / recent / overview / facets 一律仍按「每一次调用自身」的用量统计，不做子树合计（否则同一笔调用会在总览里被重复计入）。
7. **固定口径 KPI 条**（今日 / 本月 / 活跃天数 / 峰值日）：今日与本月是**固定窗口**（今日 0 点起、本月 1 日 0 点起至 now），不随所选范围变化；活跃天数与峰值日按**所选范围**计算，与每日趋势图共用同一份合并后的 `daily`。峰值日 = 范围内 **token（`input + output`）最高**的那一天（并列取较早），展示该日的调用数、token 与费用（token 口径与今日/本月一致，缓存读是输入子集不再叠加）。**峰值日只在合并层推导**（`mergeLedgerPayloads` 基于合并后的 daily 取最大行）：跨源合并后的 daily 才是权威，单源各自的峰值在合并后无意义——故 `ledgerAggregate.ts` 与 WSL dump 均不产出这四个字段（schema 中为 optional），WSL 源缺该字段不影响合并。范围内无调用时 UI 显示「峰值日：--」。

## 会话层级

`session` 表自带 `parent_id` / `task_type` 两列，`parent_id` 是层级父边的唯一来源（不另建关系表，也不在读取层推导）。账本据此把会话表从平铺列表升级成可折叠的树。

**口径（不变式）**

1. **每行数值 = 该会话自身 + 它的全部后代（沿层级边）**：calls / inputTokens / outputTokens / cost 按子树求和，`lastActiveMs` 取子树内最大值。**顶层行（无层级父）的合计相加 = 全集合计**，不双计。
2. **fork 不参与层级**：会话自身 `task_type === "fork"` ⇒ 报送的 `parentSessionId` 恒为 `null`（断边）。fork 是「从某会话复制出来的独立分支」，把它的用量算回来源会话会让来源行的成本凭空翻倍。其余类型（interactive / subagent_child / selection_side_chat / workflow_child）都挂父边；**fork 里派出的子代理仍挂在 fork 下**（断的只是 fork → 来源那一条边）。
3. **`childCount` = 直接子会话数**，按**断 fork 边之后**的边计数；自引用脏数据不计入。
4. **层级边只可能存在于同一数据源内，关系键是「来源 + 会话 id」而不是裸会话 id**：`parent_id` 是库内本地 id，跨数据根（不同 `.zcode-*` 身份、WSL 与 Windows）不存在父子关系。所以子树合计在**单源聚合内**一次算完，多源合并只做拼接、重排与再截断。之所以不能只按 id 认父：身份迁移会让同一会话在两个数据根各留一份（本机实测 342 个会话同 id 双份，含那个挂了 89 个子代理的父会话），裸 id 认父会让 A 根的子行认到 B 根的同 id 行——那个父行凭空多出不属于自己的子行，而它自己那棵子树的子行反被合并层连带丢弃。TS 侧键在 `ledgerSessionTree.ts` 的 `factKey`，UI 建树同理（`sessionTree.ts` 的 `sessionRowKey` 含 src），WSL Python 一次 dump 只含单一来源，键退化为会话 id。
5. **截断按顶层会话数计，且必须保父链完整**：单源配额 200、合并后 500，计的是顶层会话（整棵子树跟随父一起进入结果）。父在集合里而子被保留、或子被保留而父被丢掉（悬浮行）都不允许。实现（`ledgerSessionTree.ts selectLedgerSessionRows`）：按**子树 tokens 降序 → depth 升序 → sessionId 升序**排序后单遍扫描，`父在集合里但未被保留 ⇒ 丢弃该行`。因为父的子树 tokens ≥ 任何后代的子树 tokens，加上 depth 升序 tie-break，父必然先于子被处理，所以这个单遍规则就能保住整棵子树。
6. **孤儿、自引用与环（脏数据）**：`parent_id` 指向集合内不存在的会话时按顶层行处理并保留（本机实测 `model_usage.session_id` 100% 能 JOIN 上 `session`、无孤儿，此路只为健壮性）；向上累加遇到父不在集合内即停止；自引用（parent === 自身）边视为已断；父链遍历有 64 步上限，环必然终止。全程静默降级，不挂起不抛错。自引用行在保父链规则下会被整体丢弃（真实数据不可能出现）。

**实现分工**（语义只有一份，两侧必须逐条对齐；改动任一侧同步另一侧）

| 位置                                 | 职责                                                                                                                       |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `ledgerSessionTree.ts`               | 纯函数 domain 层：`breakForkEdges` / `rollupSubtrees` / `selectLedgerSessionRows`，无 IO、无 await                         |
| `ledgerAggregate.ts`（Windows 直读） | 会话聚合 SQL 补 `s.parent_id` / `s.task_type`，折叠出「自身」用量后调 `selectLedgerSessionRows(rollupSubtrees(rows), 200)` |
| `ledgerDumpScript.ts`（WSL Python）  | 同一套算法用 Python 重写，输出字段名与 TS 侧一致（`parentSessionId` / `taskType` / `childCount`）                          |
| `ledgerMerge.ts`                     | 合并后对 sessions 再跑一次 `selectLedgerSessionRows(rows, 500)`（跨源无父子关系，但重排后仍可能切掉父行）                  |

## 价格管理与别名

价格表原本只有「改文件」这一条路：用户想给未计价模型补价，或把中转站的模型别名指向官方模型，只能手改 `<数据根>/v2/usage-prices.json`。本节把手动定价变成 UI 可操作的能力，并把别名从「复制两份价」升级成真正的引用。

**数据模型（三层不变，只加两样东西）**

1. 用户覆盖层 `usage-prices.json` 新增 `_aliases` 段：`{ "<别名>": "<目标模型>" }`。`_` 开头仍是元信息命名空间，旧版本读到 `_aliases` 会当元信息跳过，不会把别名误当价格。
2. `LedgerPriceTable` 增加三个可选溯源字段：`sources`（每个键来自哪一层：`builtin` / `synced` / `user`）、`aliases`（用户声明的原始映射）、`aliasTargets`（展开后每个别名最终命中的目标键）。可选是因为测试与外部构造的裸表（只喂 `calcLedgerCost`）不需要溯源；loader 产出永远带齐。

**行为**

- **别名只在 `LedgerPriceLoader.load()` 展开**：合并三层后，对每个别名沿映射链找目标键的最终价，找到就把它设为别名键的价格。WSL dump 用的价格表就是 loader 合并后序列化的产物（`ledgerReader.ensureDumpAssets`），所以费用公式、Windows 聚合、Python `calc_cost` 与两侧对拍全部零改动。
- **显式定价优先于别名**：别名键自己有任何一层的价格时，别名不覆盖它。这样「先补了价、后配别名」不会让价格凭空消失。
- **防环**：链式查找带访问集合与深度上限（8 层），成环即中断，别名保持未定价，不抛错。
- **来源标注**：别名展开出来的键标 `source: "user"`（键的存在由用户声明决定），并带 `aliasOf` 指向最终目标；来源层只影响 UI 展示与「恢复默认」可用性，不影响计价。
- **写操作只动用户覆盖层**：`setLedgerPrice` / `deleteLedgerPrice` / `setLedgerPriceAlias` 全部读-改-写 `usage-prices.json`，保留文件里其它未知键与 `_meta` 原样。同步按钮仍只写中间层，两者互不覆盖。
- **写入语义**：`set` 写小写模型名的三价（input/output/cacheRead，非负有限数）；`delete` 只删用户覆盖键，等于「恢复默认」（回落到同步层或内置基准）；`setAlias` 传 `target=null` 即删除别名。设置别名时若同名键有用户显式定价，一并删除该定价，让别名真正生效；设置价格时若同名键是别名，一并删除该别名。
- **每次成功写入后 `priceLoader.invalidate()`**，下一次快照即用新价；失败原样保留旧文件并回传错误文案。
- **UI**：页脚「价格管理」打开对话框。搜索框按模型 id 子串过滤（服务端过滤 + `limit` 截断，默认 200 条，返回 `total` 用于提示）；表格每行显示模型、来源徽标、三价与操作（编辑 / 恢复默认）；顶部列出快照里的未计价模型，点击直达编辑；底部别名区可增删映射，目标未定价的别名显式标「未解析」。

**所有权与不变式**

- 价格表唯一写入方是 `IUsageLedgerService` 的三个变更方法（host 进程内），UI 不直接碰文件。
- 用户覆盖文件损坏时：读取层继续忽略（现有行为不变）；写入层拒绝覆盖并返回错误——否则一次「改价」会把用户手写的整份文件抹成只剩一条。
- 别名不改变 `calcLedgerCost` 的输入契约：它拿到的仍是「模型 id → 三价」的扁平表。

## 只读不变式（硬约束）

- SQLite 全程 `readOnly: true` + 短连接，每请求用完即关；**绝不持有长连接**——长读事务会阻碍主程序 WAL checkpoint。
- SQL 全参数化；条件文本只用静态列名，无动态字符串进 SQL 文本。
- WSL 侧绝不在 Windows 侧直开 WSL 的 SQLite 文件（跨文件系统 WAL 锁），一律把聚合脚本送进 WSL 执行、只回传 JSON；进程执行（spawn wsl.exe）全部隔离在 ledgerWsl.ts，命令一律走 `wsl.exe --exec` 直通模式 + base64url 编码传筛选值。
- **`--exec` 是硬要求，不能用裸 `--`**：裸 `--` 会把参数交给 WSL 侧 shell 分词，而 shell 的 cwd 是 Windows 进程 cwd 的 /mnt 映射——若 cwd 里恰好有 `.zcode-*` 文件（打包产物的 `.zcode-install-manifest` 就是一例），`find -name .zcode-*` 的通配会被 shell 展开成那个文件名，探测静默失真（2026-10-03 实测：打包版 host 的 cwd 是 win-unpacked，导致 WSL·自建源从此探测不到，且无任何报错）。`--exec` 把参数原样传给目标程序，无 shell 展开面。
- 日志不写凭据、不写明文 key。

## 失败语义

| 场景                                | 行                                                                                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 主源（host 数据根）读取失败且被选中 | 抛错，UI 进入错误态（含库路径）                                                                                                    |
| 其余源失败                          | `source.ok=false` + 截断错误信息，不挡页面；KPI 上方细条提示                                                                       |
| WSL dump 失败                       | 该 (distro, root) 记入失败表并落 `warn` 日志；60s 退避内跳过聚合，但源**保留在 sources**（`ok=false`，error 注明「上次聚合失败」） |
| WSL 发行版停止 / 探测瞬态失败       | 已知源按 stale 保留在 sources（`ok=false`，注明「未在运行」），30 分钟后移除；不重探停止的发行版（避免把 WSL 拉起）                |
| 价格表缺失/损坏                     | `pricesLoaded=false`，费用相关输出为 null，UI 显示「未加载价格表」                                                                 |
| 价格基准同步失败                    | 旧基准原样保留，页脚按钮旁显示「同步失败」，错误详情挂 tooltip                                                                     |
| 用户覆盖文件损坏后改价              | 拒绝写入并回传错误（不覆盖原文件），避免把用户手写的整份价格表抹掉                                                                 |
| 远端 workspace                      | 服务不存在，UI 展示不可用空态                                                                                                      |

**源可见性不变式**（`ledgerWslVisibility.ts`，纯函数 + 单测守护）：任何「暂时不可聚合」的 WSL 源都必须继续出现在 `snapshot.sources` 里灰显，绝不允许从来源列表凭空消失——否则用户看到的是统计无声丢失且无从排查。规则：退避窗口（60s）内跳过聚合但保留源；发行版停止/探测未确认的源保留 30 分钟。

## 迁移边界

- 单价表分三层，后层覆盖前层：内置基准（`ledgerPrices.ts` 内 `_meta.date` 标注基准日）< 同步基准 `<数据根>/v2/usage-prices-baseline.json` < 用户覆盖 `<数据根>/v2/usage-prices.json`（按小写模型名覆盖，损坏忽略）。
- **价格基准手动同步**（`ledgerPriceSync.ts`）：界面页脚「同步」按钮触发 `syncLedgerPrices`，拉 models.dev 公开目录（api.json）写入同步层；只写中间层，绝不改用户覆盖文件。同名模型被 30+ 渠道各报一次价，取价口径与内置基准一致：**厂商自营目录优先**（deepseek/zai/alibaba/moonshotai/openai/stepfun/xiaomi 等白名单），无官方价时取非零条目的众数（来源一致价），**最高票并列（平票）视为无一致价、不写入该模型**（回退内置基准或记未定价，绝不按目录插入顺序随机取一家——曾随机取中 cacheRead=输入价的劣质条目，叠加双计费把估算抬到真实值的 34~68 倍），全零按免费档；基准日期取本机日期。网络/解析失败或模型数低于阈值时报错并保留旧文件。不做定时自动同步——估算口径何时变化由用户知情触发。
- CLI 写入侧 30 天保留策略不动：账本如实展示库内现有数据。
- 筛选偏好（范围/供应商/模型/来源/刷新间隔/图表指标）存 localStorage `zcode.ledger.prefs.v1`，逐字段校验、损坏忽略；来源全选存 null（跟随未来新增数据根）。
