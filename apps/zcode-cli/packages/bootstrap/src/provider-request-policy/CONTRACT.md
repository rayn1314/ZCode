# provider-request-policy

## 意图

把 provider 账号级的「每分钟 N 次」配额收成**端口上的一层装饰**（`ProviderRateLimitPort`）：调用路径
不需要各自记得加限速，只需要带端口——覆盖面因此等于端口的装配范围，新增路径的问题从「记得加限速」
变成「记得带端口」。完整设计与验收见 `bootstrap/spec/provider-request-rate-limit.md`。

## 不变量

- 余额的唯一所有者：默认是进程单例 `getProviderRateLimiter` 的进程内桶；装配了共享账本时改为那个文件
  （同机多端：Windows `%ProgramData%` 与 WSL `/mnt/c/...` 指向同一份）。降级期间两者**不叠加计数**。
- 桶按**账号指纹**（providerId + 协议 + 端点 + 凭据 sha256）分，不按 providerId 分；凭据只进哈希。
- 配置唯一来源是 `ProviderConfig.requestPolicy.requestsPerMinute`，每次请求重读；改配置立刻生效但
  **不重置余额**。非法值（0 / 负数 / 非有限）等价于不限速，且不留任何状态。
- 跨进程临界区只有「加锁 → 读 → 补 → 扣 → 写 → 放锁」，抢锁是**有限等待**（2 秒），判僵尸锁只看
  锁文件 mtime 年龄、不看 pid（Windows 的 pid 在 WSL 里无意义，按 pid 判活会偷走活锁）。
- 绝不 fail-open：账本不可达 / 目录不可写 / 内容损坏一律退回进程内限速，并记一条 warn（60 秒节流）。
- 「只带配额」的准入端口（`createRateLimitOnlyAdmission`）**不提供 `tryAcquire`**：提供了就变成并发
  闸门，会把 legacy 路径拉进治理器的在飞统计，并让 runner 分不清「排了队」与「立即放行」。
- 限速层不抛错、不干预重试；等待期间 abort 立刻摘除等待者，队列空了连定时器一并撤（默认定时器 unref）。

## 与其它模块的交集

- `apps/zcode-cli/packages/contracts`（`ModelRequestAdmission`）：端口消费方是 model runner——它固定
  **先 `awaitRateLimit` 后 `tryAcquire`**，这是载荷性顺序，不在本模块内改。
- `packages/provider`（Provider Registry）：本模块只通过注入的 `ProviderConfigReader` 读已解析配置，
  不反向依赖 Registry 形状；装配点（`create-app.ts`）负责把 Registry 的读法喂进来。
- 子会话 / dwf actor / legacy workflow 各自的端口来源不同（继承父端口 / per-actor 准入端口 /
  配额-only 端口），但都指向同一份配额——新增调用路径时改的是**端口来源**，不是限速实现。

运行时回归位于 `tests/provider-request-policy/`（契约）与 `tests/provider-rate-limiter.test.ts`、
`tests/provider-quota-wiring.test.ts`、`tests/provider-quota-app-boot.test.ts`（实现）。
