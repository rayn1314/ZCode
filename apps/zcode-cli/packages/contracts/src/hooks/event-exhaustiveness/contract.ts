import type { HookEvent } from "@zcode/shared";
import type { HookInput, HookSpecificOutput } from "../index.js";

/**
 * hook 事件的类型级穷尽守卫（spec: core/spec/hook-framework-expansion.md §5.3）。
 *
 * 意图只有一个：事件名单一来源（`@zcode/shared` 的 `HOOK_EVENT_NAMES`）新增事件时，
 * `HookInput` / `HookSpecificOutput` 这两个联合缺键必须**在编译期**报错，而不是等到
 * 运行时某个 `default` 分支悄悄吞掉新事件。
 *
 * 因此本模块没有任何运行时逻辑与副作用：守卫在导入时求值，结果恒为 `true`；
 * 条件类型落空（键集合漂移）时它收敛成 `never`，`= true` 赋值即编译失败。
 * 幂等、无 IO、不发事件、不等待持久化——读多少次都一样。
 */

// 真实断言值：两个常量由 `../event-exhaustiveness.js` 计算，再经此处对外暴露给断言与自检消费。
export { _checkHookInput, _checkSpecificOutput } from "../event-exhaustiveness.js";

/** 事件单源是否被 `HookInput["hookEventName"]` 覆盖；成立收敛为 `true`，否则 `never`。 */
export type HookInputEventNamesAreExhaustive = HookEvent extends HookInput["hookEventName"]
  ? true
  : never;

/** 同上，针对 hook 事件专属输出联合 `HookSpecificOutput["hookEventName"]`。 */
export type HookSpecificOutputEventNamesAreExhaustive =
  HookEvent extends HookSpecificOutput["hookEventName"] ? true : never;

/**
 * 穷尽守卫的对外契约：把「守卫已生效」与「运行时事件名映射完整」两件事一起表达出来，
 * 供调用方自检。三个字段都是常量式读取，不存在状态迁移。
 */
export interface EventExhaustivenessContract {
  /**
   * `HookInput` 的事件键集合覆盖事件单源的断言值。
   * 前置：无（模块导入即完成求值）。后置：恒为 `true`；类型级不成立时本文件无法编译。
   */
  readonly checkHookInput: true;
  /** `HookSpecificOutput` 的事件键集合覆盖事件单源的断言值，语义同上。 */
  readonly checkSpecificOutput: true;
  /**
   * 事件单源到运行时事件名清单（`contracts` 的 `HookEventName`）的映射：
   * 键必须恰好等于事件单源全集，值必须是同名事件——缺键或改名都会在 `satisfies` 处编译失败。
   */
  readonly eventNames: Readonly<Record<HookEvent, HookEvent>>;
}
