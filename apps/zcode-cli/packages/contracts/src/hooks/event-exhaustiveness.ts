import type { HookEvent } from "@zcode/shared";
import type { HookInput, HookSpecificOutput } from "./index.js";

/**
 * 类型级穷尽断言（spec §5.3）。
 * 这不是运行时逻辑：当 HookInput / HookSpecificOutput 的事件键集合与事件单源
 * HOOK_EVENT_NAMES 不一致时，条件类型会得到 never，`= true` 赋值即编译失败。
 * 请勿把本文件当作样板删除——它防止后人手工维护事件列表时漏掉某个事件，
 * 或在 HookSpecificOutput 增加/删除事件成员时忘记同步。
 */
type _AssertSpecificOutputExhaustive =
  HookEvent extends HookSpecificOutput["hookEventName"] ? true : never;
export const _checkSpecificOutput: _AssertSpecificOutputExhaustive = true;

type _AssertHookInputExhaustive =
  HookEvent extends HookInput["hookEventName"] ? true : never;
export const _checkHookInput: _AssertHookInputExhaustive = true;