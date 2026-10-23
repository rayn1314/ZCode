/**
 * event-exhaustiveness 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import { HookEventName } from "../index.js";
import {
  _checkHookInput,
  _checkSpecificOutput,
  type EventExhaustivenessContract,
} from "./contract.js";

/**
 * 最常见的用法：把守卫的求值结果与运行时事件名清单装成契约对象，交给自检/断言消费。
 *
 * 注意这里没有「一次调用」——守卫在 `../event-exhaustiveness.js` 被导入时就已经完成，
 * 调用方拿到的是结果本身，而不是需要主动触发的函数。
 */
export const exampleEventExhaustiveness: EventExhaustivenessContract = {
  checkHookInput: _checkHookInput,
  checkSpecificOutput: _checkSpecificOutput,
  eventNames: HookEventName,
};
