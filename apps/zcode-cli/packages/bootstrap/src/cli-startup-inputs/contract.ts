// ============================================================
// cli-startup-inputs 对外契约：App 创建期的磁盘解析快照（解析一次、供多个 App 复用）
// ============================================================
// 意图：把「解析配置 / 加载 agent profile / 发现插件（含**同步**插件发现）/ 解析内置技能包」这四件
// 读盘的事抽成显式的一步。正常会话每次创建都调用它（`createZCodeApp` 的默认路径）；子会话由构造
// 入口传入父已解析好的结果，不重复付一次会话启动成本。
//
// 调用方必须知道的不变量：
//
// 1. **没有进程级缓存，也不该有**：每次调用都按当前磁盘现状重新读。冷恢复会重建 App，天然拿到新
//    catalog；已有 Session 不热加载新 Plugin——这是既有语义，加缓存会改掉它。
// 2. **复用只能显式表达**：唯一入口是把快照放进 `ZCodeAppOptions.startupInputs`（子会话复用父会话
//    那一份），不要用「参数相同就复用」这类隐式判断。
// 3. **快照是只读派生**：除 `configResult` 由 App 自己的 facade 原地更新 `ui.locale`（既有行为）
//    之外，其余字段调用方不得改写；要换就重新解析一份。
// 4. **空清单是合法结果**：没有插件 / 没有 profile / 没有技能根都不是错误，调用方不要据此判失败。
//
// 与子会话的 hook 点：子会话借用的不只是这份快照，还有进程内适配器实例（执行端口 / artifact store
// 等），两者的装配都在 `create-app.ts` 的同一处闭包完成，见 spec `subagent-session-as-first-class.md`。

import type { ZCodeAppOptions } from "../app/types.js";

/** 一次启动输入解析。前置：`workingDirectory` 已规范化为执行工作目录；后置：返回本次观测到的快照。 */
export { resolveStartupInputs } from "../app/startup-inputs.js";

export type { ResolveStartupInputsInput, ZCodeAppStartupInputs } from "../app/startup-inputs.js";

/** 复用的注入点：唯一表达「复用父会话快照」的字段，其余派生值由 `create-app.ts` 从快照里取。 */
export type StartupInputsReuseTarget = Pick<ZCodeAppOptions, "startupInputs">;
