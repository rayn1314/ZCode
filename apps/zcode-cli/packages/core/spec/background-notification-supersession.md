# 后台通知的投递期消解与批内归一

涉及包：`apps/zcode-cli/packages/core`（本 spec 主责：通知命令、drain 出口、生产者标注）。
引用包：无（同一 runtime 内完成，协议与 UI 零改动）。

## 背景与问题

后台任务通知（`<task-notification>`）是 finalize 那一刻冻结的快照：`enqueueBackgroundTaskNotification`
把渲染好的文本原样入队，父代理读到的永远是入队时刻的状态。任务状态会继续变化——
子代理可被 SendMessage 续跑或被用户经面板直发复活（spec `subagent-input-revival.md`），
Bash/workflow 任务可被重臂——每一次变化都会产生一条**新**终态通知，而旧快照仍躺在队列里。
由此产生两个父代理可见的错误视图：

1. **过期终态通知**：任务挂掉 → 失败通知入队；用户在主代理下一次请求前手动续跑 →
   注册表重新 running → 复活跑完再入一条成功通知。两条都在队列里，父代理先读到
   「失败」，习惯性重开一个重复子代理——复活的那份结果要么太晚、要么被当成第二次
   任务的噪音。用户在复活前手动干预的窗口被彻底浪费。
2. **同任务多快照**：即使两条通知都更新（失败 + 成功），按序投递也让父代理
   「先后读到两个状态」，模型无法可靠判断哪个是当前事实。

同期还有一类通知**不能**被动到：workflow 的 stall / escalation / hole 进度通知
（`runtime/methods/dynamic-workflow-run-progress.ts`、`dynamic-workflow-run-hole-notification.ts`）
在 run 进行中发出——按「任务现在非终态就丢」的粗糙规则会把它们全部误杀。

根因：通知链是「一次性推送、无状态消解」——`runtimeTaskRegistry` 是任务状态的唯一权威
（spec `background-stop-registry-authority.md` 已确立），但两个 drain 出口投递时
从不回查它。

## 设计决策

- **D1 通知命令携带宣告状态 `announcedTaskStatus`。** 只有宣告**终态**的生产者
  （子代理 finalize、Bash/workflow 终态回合的 tool executor）在入队时标注任务的
  registry 终态；进行中的进度通知刻意不标。词汇表外的值按非终态处理——
  不猜，宁可投递也不误杀。
- **D2 投递期按 registry 消解。** 一条通知可投递 ⟺ 非「宣告终态 ∧ 当前注册表非终态」。
  任务被复活/重臂后旧快照不再代表当前状态，而新生命会在自己的终态再发一条
  （两条复活路径都会把注册表条目的 `notified` 重置为 false，终态通知不会被幂等闸堵死）。
  registry 条目缺席（终态驱逐 / 跨进程重启）时保留原文投递——与
  `background-stop-registry-authority.md` 的「注册表缺席时投影兜底」同一原则。
- **D3 同批同任务的终态快照只投最新一条。** 消解只覆盖「当前非终态」；任务若已再次终态
  （失败 → 复活 → 完成），同批里两条快照按 taskId 去重、保留入队最晚的那条。
  终态通知是快照不是流水，历史对父代理是噪音。**只对宣告终态的快照去重**——
  workflow 的 stall/escalation/hole 是同一 run 的多条独立进度事实，全部投递。
- **D4 两个 drain 出口共享同一过滤函数。** mid-turn steer 注入
  （`drainPendingRuntimeCommandsForActiveLoop`）与 idle 唤醒批次
  （`runTaskNotificationBatch`）都用 `selectDeliverableTaskNotifications`，
  防止同一队列在两个出口给出不同的父代理视图。
- **D5 复活可见性：复活开轮即向父代理补一条 `status: running` 通知**
  （spec `subagent-input-revival.md` D8）。父代理只持有旧终态快照，用户面板发起的
  复活对它不可见；不补这条「又活了」，它会照旧重开重复子代理。SendMessage 续跑的
  工具回执已自带同义句，D5 只覆盖 input revival。该通知不带 `announcedTaskStatus`
  的终态语义（running 非终态），永远不会被 D2 消解；也刻意不经
  `enqueueBackgroundNotification`（那条路会 claim `notified`，堵死终态通知）。

## 行为

| 场景（队列里的终态通知，宣告状态 → 投递时注册表） | 投递结果 |
| ------------------------------------------------ | -------- |
| failed → 任务仍是 failed（无人复活）             | 投递     |
| failed → 任务 running（已复活）                  | 消解（丢） |
| failed → 任务 completed（复活且跑完）            | 与 completed 那条去重，只投 completed |
| lost → 注册表条目缺席（驱逐/重启）               | 投递（兜底，不猜） |
| 进度通知（无宣告状态），run 进行中               | 投递（永不被消解） |
| 同一 run 的多条进度通知（stall + escalation）   | 全部投递（不参与去重） |
| 复活 running 通知（D5），任务已 completed        | 投递（历史事实：它确实活过） |

同批混合其它命令（prompt / subagent-message / control-only-turn）不受影响；
`control-only-turn` 的既有断序语义（其后的通知留给外层队列）保持。

## 所有权与不变式

- 命令形状唯一 owner：`runtime/command-queue.ts` 的 `TaskNotificationRuntimeCommand`；
  过滤逻辑唯一 owner：`runtime/methods/background-notifications.ts` 的
  `isSupersededTaskNotificationRuntimeCommand` / `selectDeliverableTaskNotifications`，
  两个 drain 出口只调用、不复制。
- 生产者标注是显式契约：新增终态通知生产者必须传 `announcedTaskStatus`，
  否则它的快照在复活窗口里会漏出去（类型不强制，测试与 code review 把关）。
- 账本：被消解的命令沿用既有抑制语义——ledger 条目保持 admitted，session resume 时
  收口为 `discarded(session_resumed)`（与 sealed-subagent-bash 抑制同一留痕路径）。
- registry 仍是任务状态唯一权威；本 spec 只改「什么被投递」，不改任务状态本身。

## 失败语义

- 消解判定抛异常 → drain 照旧失败（既有错误传播），不降级为「全部投递」。
- 通知无 taskId → 无法消解，原样投递（与现状一致）。
- 复活通知入队失败（父 runtime shuttingDown 等）→ 被既有守卫丢弃并留日志，
  不影响复活轮本身。

## 迁移边界

- 不改终态通知的文本与 `<task-notification>` 家族格式（新增的复活通知例外，D5）。
- 不改 TaskOutput / ListAgents / 面板的读取路径（它们已直读 registry/投影）。
- 不覆盖：父代理已把过期失败读进上下文之后才发生的复活——已读走的信息收不回，
  D5 的通知只能让它尽快知道「别重复」。这是推送式通知的固有边界。
- 不覆盖：跨进程/重启后的通知补投（input-revival spec 的同类遗留）。
