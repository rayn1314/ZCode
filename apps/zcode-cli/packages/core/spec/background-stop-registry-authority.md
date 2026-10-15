# 后台任务停止判定的权威归属（registry 单源）

涉及包：仅 `apps/zcode-cli/packages/core`（`runtime/methods/background.ts`）。
触发场景横跨两条续跑路径：SendMessage 续跑（上游既有）与输入复活
（spec `subagent-input-revival.md`，后者补发事件的部分记在该 spec D7）。

## 背景与问题

`stopBackgroundTask` 的终态判定 `isTerminalBackgroundStopTarget` 此前是
「注册表或投影任一说终态即终态」的 OR 逻辑，而报错文案打印的是注册表状态。
两个状态源在续跑场景必然分歧：

- 注册表（`runtimeTaskRegistry`）是内存权威；SendMessage 续跑与输入复活都把它
  的条目重新注册为 `running`（新一轮生命）。
- 投影（`projection.backgroundTasks`）从持久化事件流重放；续跑只补发
  `SubagentSpawned`（reducer 不消费它），旧生命的 `BackgroundTaskCompleted`
  永远留在投影里。

分歧的后果：复活期间主模型 TaskStop 被以
`Task X is not running (status: running)` 拒绝（拒绝理由来自投影终态、括号状态
来自注册表，自相矛盾）；用户面板停止走非 strict 分支静默返回「已终态」，两条
停止路径都停不掉一个真实在跑的任务。

## 设计决策

- **D1 停止终态判定以注册表为唯一权威。** 与本文件顶部「回收判定必须直接读取
  runtime task registry，不能从协议投影或 UI 状态猜测」同一归属原则。注册表在场
  时投影无否决权。
- **D2 投影只在注册表条目缺席时兜底。** 终态条目驱逐（`MAX_TERMINAL_RETAINED`）
  或跨进程重启后，注册表没有条目、投影仍有历史记录；此时维持「not running」
  拒绝语义，避免对旧任务发起无意义的停止调用。
- **D3 双结算防护不在此层。** 防重复结算由 runner `stopTask` 终态守卫、
  `finalize*` 终态守卫与 `notified` 幂等闸三重保证；放宽 OR 判定不打开双结算之门。

## 行为

- 注册表条目 running + 投影终态（续跑后）：TaskStop 与 GUI 停止**放行**，走
  对应 taskType 的真实停止分支。
- 注册表条目终态：拒绝（strict 报 `background_task_not_running`，状态打印注册表
  终态，与拒绝理由一致）。
- 注册表条目缺席 + 投影终态：拒绝（兜底，语义与旧行为一致）。
- 注册表条目缺席 + 投影 running/缺席：放行到停止分支后由各 taskType 的
  not-found 语义接管（与旧行为一致）。

## 所有权与不变式

- 任务是否在运行，唯一 owner 是父 runtime 的 `runtimeTaskRegistry`；投影是历史
  重放，不表达「当前」。
- 报错文案打印的状态必须与终态判定同源（注册表在场时打印注册表状态）。

## 失败语义

- 注册表滞留 running（轮崩溃未结算）而投影已终态：停止会真实执行并把任务收敛为
  终态（补发 stopped 通知）。比旧行为（拒绝且文案矛盾）更符合直觉，`notified`
  幂等闸保证不产生重复通知。
- 停止分支内部失败（如 `subagentPort.stopTask` 缺席）沿用既有
  `background_task_cancel_not_supported` 语义，不变。

## 迁移边界

- 不改：三条 taskType 停止分支内部逻辑、`stopTask`/`finalize*` 守卫、通知语义。
- 不覆盖：跨进程续跑（注册表与桥均为内存态，spec `subagent-input-revival.md` D6
  降级范畴）。
