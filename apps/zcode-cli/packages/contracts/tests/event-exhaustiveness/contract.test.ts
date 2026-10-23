import { expect, it } from "vitest";
import { HOOK_EVENT_NAMES } from "@zcode/shared";
import {
  _checkHookInput,
  _checkSpecificOutput,
} from "../../src/hooks/event-exhaustiveness/contract.js";
import { exampleEventExhaustiveness } from "../../src/hooks/event-exhaustiveness/contract.example.js";
import { HookEventName } from "../../src/hooks/index.js";

it("两个类型级穷尽断言在运行时求值为真", () => {
  expect(_checkHookInput).toBe(true);
  expect(_checkSpecificOutput).toBe(true);
  expect(exampleEventExhaustiveness.checkHookInput).toBe(true);
  expect(exampleEventExhaustiveness.checkSpecificOutput).toBe(true);
});

it("运行时事件名清单与事件单源同集合同顺序", () => {
  // 顺序也要一致：HookEventName 是 HOOK_EVENT_NAMES 的机械镜像，漂移即说明有人手工改了其中一份。
  expect(Object.values(exampleEventExhaustiveness.eventNames)).toEqual([...HOOK_EVENT_NAMES]);
  expect(Object.keys(exampleEventExhaustiveness.eventNames)).toEqual([...HOOK_EVENT_NAMES]);
  expect(exampleEventExhaustiveness.eventNames).toBe(HookEventName);
});
