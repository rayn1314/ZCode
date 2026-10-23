# usage-ledger

## 意图

一台机器上同时存在多个 ZCode 数据根（Windows 官方根、自建 `.zcode-<身份>` 根、WSL 各发行版内的根），
各自的 `cli/db/db.sqlite` 只记自己那份调用。本模块把它们聚合成一份**只读**用量账本
（四口库合并 + 会话层级 + 固定窗口 KPI + 峰值日），并把手动定价、模型别名做成 host 侧可写能力。

完整口径与失败语义见 `packages/services/spec/usage-ledger.md`（不在此复制正文）。

## 不变量

- **只读**：所有源都用 `readOnly: true` 短连接打开，用完即关；WSL 侧绝不从 Windows 直开对方的
  SQLite（跨文件系统 WAL 锁），一律送聚合脚本进 WSL 执行、只回传 JSON。
- **token 口径**：`cacheRead ⊂ input`、`reasoning ⊂ output`，任何合计只用 `input + output`；
  费用先把命中部分从输入里扣掉再计价，否则命中 token 双计费（历史上把 ~$104 算成 $7,069）。
- **未定价不静默归零**：未定价模型的调用进 `unpricedCalls/unpricedModelIds`，费用字段可为 null。
- **会话层级**：每行数值 = 该会话自身 + 全部后代（沿层级边），顶层行合计相加 = 全集合计；
  fork 断边（`task_type === "fork"` ⇒ `parentSessionId = null`）；截断按**顶层会话数**计且
  **必须保父链完整**；关系键是「来源 + 会话 id」，跨数据根不存在父子关系。
- **峰值日只在合并层推导**：`mergeLedgerPayloads` 基于合并后的 `daily` 取 token 最高的一天
  （并列取较早），单源聚合不产出这四个字段。
- **源可见性**：任何「暂时不可聚合」的 WSL 源都必须继续出现在 `snapshot.sources` 里灰显
  （dump 失败退避 60s、发行版停止保留 30min），绝不从列表凭空消失。
- **价格三层**：内置基准 < 同步基准 < 用户覆盖，后层覆盖前层；写操作只动用户覆盖文件，
  读-改-写保留其它未知键与 `_meta`，文件损坏时拒绝写入。别名只在加载时展开：显式定价优先于别名，
  链式查找深度上限 8，成环即中断且不抛错。

## 与其它模块的交集（hook 点）

- **价格写操作之后**：服务内唯一失效点是 `LedgerPriceLoader.invalidate()`（仅 `ok=true` 时调用）；
  下一次 `getLedgerSnapshot` 即用新价。UI 由 `useLedgerPrices` 在写成功后重拉列表，
  快照刷新由面板负责——费用口径跟着价格变，但刷新时机不由服务推送。
- **数据根探测**：账本只保留自己的相对路径（`cli/db/db.sqlite`）、TTL 与来源 key/标签，
  官方根候选链与自建根扫描复用 `data-roots` 模块的 `machineDataRoots.ts`（同一份探测，避免两份真相）。
- **远端与 Web**：服务只在 `packages/services/src/node.ts` 注册；`accessor.usageLedgerService` 是可选字段，
  UI hook（`useLedgerStats` / `useLedgerPrices`）把「服务缺失」翻译成 `unavailable` 空态，
  ProxyChannel 调用 reject 也走同一降级路径，不当成错误。
- **协议**：请求/结果类型与 `ServiceChannels.UsageLedger` 全部来自 `packages/shared/src/usage-ledger.ts`，
  字段名与口径注释在那里维护；本模块不另起一份同构声明。
