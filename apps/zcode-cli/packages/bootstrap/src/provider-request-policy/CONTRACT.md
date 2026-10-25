# provider-request-policy

## 意图

把 provider 账号级的请求策略收成**端口上的一层装饰**（`ProviderRateLimitPort` + 治理器的 provider
闸门）：调用路径不需要各自记得加限速，只需要带端口——覆盖面因此等于端口的装配范围，新增路径的
问题从「记得加限速」变成「记得带端口」。两个旋钮见 `packages/provider` 的
`providerRequestPolicyDataSchema`：`requestsPerMinute`（令牌桶）与 `maxConcurrent`（并发硬上限）。
完整设计与验收见 `bootstrap/spec/provider-request-rate-limit.md`。

## 不变量

- RPM 余额的唯一所有者：默认是进程单例 `getProviderRateLimiter` 的进程内桶；装配了共享账本时改为
  那个文件（同机多端：Windows `%ProgramData%` 与 WSL `/mnt/c/...` 指向同一份）。降级期间两者
  **不叠加计数**。
- 桶键就是 **providerId**：一条 provider 配置 = 一份策略 = 一个桶，两端同名即共享。同一家供应商的
  不同 Key 合用一个桶——要各算各的配额就多建 provider 配置。凭据不进键、不进文件。
- 配置唯一来源是 `ProviderConfig.requestPolicy`，每次请求/准入重读；改配置立刻生效但**不重置余额**
  （RPM）。非法值（0 / 负数 / 非有限）等价于不启用，且不留任何状态。
- 跨进程临界区只有「加锁 → 读 → 补 → 扣 → 写 → 放锁」，抢锁是**有限等待**（2 秒），判僵尸锁只看
  锁文件 mtime 年龄、不看 pid（Windows 的 pid 在 WSL 里无意义，按 pid 判活会偷走活锁）。
- 绝不 fail-open：账本不可达 / 目录不可写 / 内容损坏一律退回进程内限速，并记一条 warn（60 秒节流）。
- 并发也是**同机两端共一份**，但机制不同：RPM 是文件锁下的原子扣减（瞬时操作），并发是「各进程广告
  自己的在飞数 + 对方按 `N − 别人` 收窄」（时长资源）。它是**收敛而非严格**的读数：有刷新窗口，
  最坏退到「各限各的」，稳态收敛到 N；柜台**没有可泄漏的状态**（进程崩了，报告按存活期过期即止）。
  不共享 / 读不到时逐字退回旧的按本进程上限行为。
- 准入端口**一站式**：主代理、workflow run 与 legacy 子代理都拿同一个装饰后的 observer 端口；不再
  提供「只带配额、并发直通」的准入实现——那种旁路会让 provider 的并发上限被绕开。
- 限速层不抛错、不干预重试；等待期间 abort 立刻摘除等待者，队列空了连定时器一并撤（默认定时器 unref）。

## 与其它模块的交集

- `apps/zcode-cli/packages/contracts`（`ModelRequestAdmission`）：端口消费方是 model runner——它固定
  **先 `awaitRateLimit` 后 `tryAcquire`**，这是载荷性顺序，不在本模块内改。
- `packages/provider`（Provider Registry）：装配点（`create-app.ts`）把 Registry 的读法喂给两个
  单例（限速器的 resolver、治理器的 `resolveMaxConcurrent`）；本模块不反向依赖 Registry 形状。
- `workflow-concurrency-governor`（并发）：AIMD 桶按 `${providerId}/${modelId}` 分（学习信号按模型
  来），provider 硬上限按 providerId 一道闸（声明约束跨模型桶结算）。两层顺序由 runner 保证
  （先配额后槽）。同机共享时，闸门可用额度扣掉 `provider-concurrency-shared` 广告的另一端在飞数。
- `provider-concurrency-shared`（同机并发读数）：进程级单例（一个进程里多个 app 必须共用一份，否则
  另一端会把同一批请求数重复加）。它只写自己那一份报告、只读别人的，不与账本共用锁；判别人的报告
  是否过期用文件系统时钟（与账本判锁龄同一套）。
- 子会话 / dwf actor / legacy workflow 各自的端口来源不同（继承父端口 / per-actor 准入端口 /
  主代理同款 observer），但都指向同一份策略——新增调用路径时改的是**端口来源**，不是策略实现。

运行时回归位于 `tests/provider-request-policy/`（契约）与 `tests/provider-rate-limiter.test.ts`、
`tests/provider-quota-wiring.test.ts`、`tests/provider-quota-app-boot.test.ts`（实现）、
`tests/provider-concurrency-shared.test.ts`（同机并发读数）、
`tests/workflow-concurrency-governor.test.ts`（闸门与共享额度）。
