# hook 事件穷尽守卫

意图：事件名单一来源（`@zcode/shared` 的 `HOOK_EVENT_NAMES`）新增事件时，必须同步到
`HookInput` / `HookSpecificOutput` 两个事件联合，缺键要在**编译期**失败，而不是在运行时
落到某个 `default` 分支被静默吞掉。

不变量：

- 守卫无运行时逻辑：`HookInput` / `HookSpecificOutput` 的事件键集合覆盖事件单源时条件类型为
  `true`，漂移即 `never`，`= true` 赋值编译失败。因此本模块幂等、无 IO、不发事件、不等持久化。
- 运行时事件名清单 `HookEventName` 与事件单源同集合、同顺序，靠 `satisfies Record<HookEvent, string>` 兜底。
- 运行时 counterpart 是 `apps/zcode-cli/packages/core/src/hooks/assertNever.ts`：事件分支的
  `switch` 用 `default: assertNever(input)` 把「漏改分支」变成类型错误，两处守卫一编译期一运行期。

与其它模块的交集在**导入点**处理，没有调用时序：

- `contracts/src/hooks/index.ts` 以 side-effect import（`import "./event-exhaustiveness.js"`）
  接入守卫；任何导入 hooks 契约的模块都会顺带校验，无需显式调用。
- 新增事件时的改动面：`HOOK_EVENT_NAMES` → `HookEventName` → 各 `*HookInput` 联合分支 →
  `assertNever` 的 switch。守卫不拥有事件数据，只断言键集合一致。

规则来源：`apps/zcode-cli/packages/core/spec/hook-framework-expansion.md` §5.3。
