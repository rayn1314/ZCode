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
3. **合并**（ledgerMerge.ts）：计数求和；均值（耗时/TTFT）按调用数加权；sessions/recent 重排后各截 **500 条**——这是 UI 翻页的数据池上限（单源 recent SQL 500、单源 sessions 200），明细表分页展示（每页 20/50/100/200 可调、偏好记忆），不再一屏平铺硬滚；**费用只累加非 null**——某源没有价格表时混入 0 会让总数凭空少一截。
4. **时间分桶**：全部参数化整数算术 `(COALESCE(started_at,0)+tzOffsetMs)/86400000`，不用 strftime/date 修饰符；WSL 侧 Python 用同一偏移（host 下发 `tzOffsetMinutes`），跨环境同一条时间轴。
5. **范围**：today=本地今日 0 点起；7d/30d 含今日；all 上界取 now（`started_at <= NULL` 恒假，不能留 null）；custom 起止可交换，止日为次日 0 点 -1。
6. **模型 × 供应商明细**：models 按 (model_id, provider_id) 分组聚合，UI「模型与供应商」表整表分页展示（费用占比 = 单行费用 / 已计价费用合计，未定价行显示「--」），还原原 zcode-usage 工具页脚 tabs 区的模型表。

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
| 远端 workspace                      | 服务不存在，UI 展示不可用空态                                                                                                      |

**源可见性不变式**（`ledgerWslVisibility.ts`，纯函数 + 单测守护）：任何「暂时不可聚合」的 WSL 源都必须继续出现在 `snapshot.sources` 里灰显，绝不允许从来源列表凭空消失——否则用户看到的是统计无声丢失且无从排查。规则：退避窗口（60s）内跳过聚合但保留源；发行版停止/探测未确认的源保留 30 分钟。

## 迁移边界

- 单价表分三层，后层覆盖前层：内置基准（`ledgerPrices.ts` 内 `_meta.date` 标注基准日）< 同步基准 `<数据根>/v2/usage-prices-baseline.json` < 用户覆盖 `<数据根>/v2/usage-prices.json`（按小写模型名覆盖，损坏忽略）。
- **价格基准手动同步**（`ledgerPriceSync.ts`）：界面页脚「同步」按钮触发 `syncLedgerPrices`，拉 models.dev 公开目录（api.json）写入同步层；只写中间层，绝不改用户覆盖文件。同名模型被 30+ 渠道各报一次价，取价口径与内置基准一致：**厂商自营目录优先**（deepseek/zai/alibaba/moonshotai/openai/stepfun/xiaomi 等白名单），无官方价时取非零条目的众数（来源一致价），**最高票并列（平票）视为无一致价、不写入该模型**（回退内置基准或记未定价，绝不按目录插入顺序随机取一家——曾随机取中 cacheRead=输入价的劣质条目，叠加双计费把估算抬到真实值的 34~68 倍），全零按免费档；基准日期取本机日期。网络/解析失败或模型数低于阈值时报错并保留旧文件。不做定时自动同步——估算口径何时变化由用户知情触发。
- CLI 写入侧 30 天保留策略不动：账本如实展示库内现有数据。
- 筛选偏好（范围/供应商/模型/来源/刷新间隔/图表指标）存 localStorage `zcode.ledger.prefs.v1`，逐字段校验、损坏忽略；来源全选存 null（跟随未来新增数据根）。
