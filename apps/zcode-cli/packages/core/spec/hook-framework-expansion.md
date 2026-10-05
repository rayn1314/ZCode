# Hook 框架通用型扩充 · 设计规格

- 状态：**v2，已按无上下文评审修订**（v1 的核心前提被推翻，见 §0）
- 主责包：`apps/zcode-cli/packages/core`（hook 执行引擎与生命周期行为）
- 涉及其它包：`packages/shared`（**单源与全部根侧副本**）、`packages/ui`、`packages/services`、`apps/zcode-cli/packages/contracts`、`apps/zcode-cli/packages/adapters`、`apps/zcode-cli/packages/bootstrap`、`apps/zcode-cli/packages/cli`
- 相关既有文档：`packages/services/spec/workspace-hook-trust-location.md`（信任库位置与不变式，不在本规格重复）
- 配套实施方案：`apps/zcode-cli/packages/core/spec/hook-framework-expansion-plan.md`

---

## 0. v1 → v2 修订记录（评审结论）

v1 提交给一个无上下文的对抗式评审后，四个基础前提被证伪。修订如下，**这几条是本规格的承重墙，不得回退**：

| # | v1 的错误前提 | 事实 | v2 的修正 |
| --- | --- | --- | --- |
| R1 | 「描述符单源建在 `contracts`，`shared`/`ui`/`adapters` 从它派生」 | `@zcode/contracts` 依赖 `@zcode/shared`（单向）；`ui`、`services` 都不依赖 contracts，根 `node_modules/@zcode` 里根本没有 contracts。根包**够不到** contracts 的描述符 | 单源下沉到 **`packages/shared/src/hooks.ts`**（唯一同时被 CLI workspace 与根 workspace 可达的层，且浏览器安全、零运行时依赖）。见 §5 |
| R2 | 「穷尽 `Record` 能让遗漏处处编译报错」，配套 `z.object(Object.fromEntries(...))` 动态生成 | `Object.fromEntries` 推导成 `Record<string, …>`，丢失字面量键，**不再报错**；`README` 等 markdown 更不可能被 TS 检查 | 改用**键控映射 + `satisfies Record<HookEvent, …>`**（保字面量 + 保穷尽，zod3/zod4 通用）；手写联合加**类型级穷尽断言**；文档一致性由**测试**保证。见 §5 |
| R3 | 「三份 schema 由描述符派生，用等价性测试兜底不漂移」 | 实际有 **19 个文件**枚举事件名（见 §1.4）；且三份 schema 今天已存在真实语义分歧（`strict` vs `passthrough`、`.int()` vs `.finite()`、`statusMessage` 有无 `min(1)`），"判定一致"要么当场红要么形同虚设；TS2742 是**编译期**问题，运行时 fixture 测不到 | 把目标从"语义等价"降级为可验证的**事件键集合相等**；分歧逐条列成**显式矩阵**（收敛或标注为有意为之）；TS2742 另加类型级守卫。见 §1.4、§5.3 |
| R4 | 「P0 零行为变化」 | 动态构造会改 `z.infer` 形状；描述符工厂若返回非判别式类型会在 **import 时抛异常** | P0 只做「键集合派生 + 类型级守卫 + 测试」，不改任何运行时判定语义；`blockable` 等能力字段在本轮**不接引擎**，明确标注为元数据。见 §3 D5、§5.4 |

同时修正了 v1 中的事实错误（压缩插入点行号、退出码归属、测试文件计数、adapters 过期版本注释），详见 §2 与 §8 的脚注。

---

## 1. 背景与问题

### 1.1 ZCode 已有完整 hook 框架（不是缺失能力）

- 7 个事件：`SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PostToolUseFailure`、`Stop`（`apps/zcode-cli/packages/contracts/src/hooks/index.ts:7-15`）。
- 执行引擎在 `apps/zcode-cli/packages/core/src/hooks/`：匹配 event + matcher、准入校验、超时与输出上限、异步 hook、生命周期事件上报。
- 两种 handler：`process`（argv）与 `command`（shell）（`contracts/src/hooks/index.ts:303-329`）。
- stdin/stdout JSON 协议，并主动补 Claude Code 兼容字段（`core/src/hooks/configured-runner-input.ts:17-66`）。
- 带摘要校验的信任状态机（`contracts/src/hooks/workspace-hook-trust.ts:31-130`），信任与声明分离存储。
- 三级来源：user / project / plugin，插件可经 `hooks/hooks.json` 挂载（`adapters/src/plugins/hook-sources.ts:8`）。
- 设置页有表单（`packages/ui/src/settings/HookForm.tsx`）与信任提示（`packages/ui/src/settings/WorkspaceHookTrustNotice.tsx:6-52`）。
- 会兼容读取 `~/.claude/settings.json`、`~/.agents/settings.json`（`services/src/hooks/hooksService.ts:35,60,247-256`）。

### 1.2 四类问题

1. **事件面窄**：压缩前后、子代理起停、会话结束都没有外部命令 hook，只有内部 `SessionEventType` 可订阅。
2. **执行面窄**：只有 `process` / `command`；Claude 有 `command` / `http` / `mcp_tool` / `prompt` / `agent` 五类，Codex 有 `command` / `mcp_tool` / `prompt` / `agent`。
3. **协议面有缺**：输出侧缺 `updatedToolOutput`；配置侧缺 `once` / `failClosed` / `if`；多 hook 决策合并规则未显式定义。
4. **地基有债**：事件名在**19 个文件**里被重复枚举（§1.4），新增事件要靠人肉记忆改一圈；hook 引擎无专门测试；文档落后于实现。

### 1.3 目标

对齐业界事实标准（以 Claude Code 为标杆），把"加一个事件"从"改十几处、靠人肉记忆"变成"**改单源一处，其余站点编译期或测试期强制暴露**"，为后续压缩 hook、子代理 hook 铺路。

### 1.4 事件名枚举的真实分布（v1 说"三份"，实际命中 19 个文件）

以 `PostToolUseFailure` 为标记全仓检索命中 **19 个文件**（含本规格自身）。其中**需要处置的枚举站点**如下（部分文件含多处，这是 P0 的工作清单基准）：

| # | 位置 | 枚举形态 | 归属类别 |
| --- | --- | --- | --- |
| 1 | `packages/shared/src/hooks.ts:4-11` | `HookEvent` 联合类型 | **单源（只改这里）** |
| 2 | `packages/shared/src/workspace-hook-config.ts:9-17` | `WORKSPACE_HOOK_EVENT_NAMES` 常量数组 | 派生 |
| 3 | `packages/shared/src/workspace-hook-config.ts:67-78` | config schema 的 `events` 键 | 派生 |
| 4 | `packages/shared/src/workspace-hook-trust-store-file.ts:22-31` | 信任库 `eventAtGrant` enum | 派生（注释已自承"与 contracts 保持一致"= 双写） |
| 5 | `packages/shared/src/zcode-protocol-v4/rows.ts:310-318` | `hookInvocationRowSchema.hookEventName` enum | 派生 |
| 6 | `packages/shared/src/zcode-protocol-v4/workspace-hook-review.ts:114-122` | review item `event` enum | 派生 |
| 7 | `packages/services/src/hooks/hooksService.ts:37-45` | `HOOK_EVENTS` + `isHookEvent` 白名单 | 派生 |
| 8 | `packages/services/src/migration/domains/hookDeclarations.ts:25-33` | `HOOK_EVENT_NAMES` + Set | 派生 |
| 9 | `packages/ui/src/settings/HookForm.tsx:35-43` | `HOOK_EVENTS` 下拉源 | 派生 |
| 10 | `apps/zcode-cli/packages/contracts/src/hooks/index.ts:7-15` | `HookEventName` 常量对象 | 派生 |
| 11 | `apps/zcode-cli/packages/contracts/src/hooks/index.ts:163-194, 248-280` | `HookSpecificOutput` 联合 + schema 判别式成员 | 手写成员 + 类型级穷尽断言 |
| 12 | `apps/zcode-cli/packages/contracts/src/hooks/index.ts:411-422` | patch schema `events` 键 | 派生 |
| 13 | `apps/zcode-cli/packages/contracts/src/hooks/workspace-hook-trust.ts:9-17, 188-196` | `WORKSPACE_HOOK_SCHEMA_FIELDS.events` + `workspaceHookEventNameSchema` | 派生 |
| 14 | `apps/zcode-cli/packages/adapters/src/config/schema.ts:272-282` | CLI config schema `events` 键 | 派生 |
| 15 | `apps/zcode-cli/packages/core/src/hooks/configured-runner-input.ts:39-60` | `switch (input.hookEventName)` 无 default | 加 `assertNever` |
| 16 | `apps/zcode-cli/packages/core/src/hooks/output.ts:118-160` | `switch` + 硬编码事件集合 | 加 `assertNever` / 集合派生 |
| 17 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts:1622,1658,1747-1750` | lane 归类与挂载判断 | 穷尽化（P1 落点） |
| 18 | `apps/zcode-cli/README.md` | 文档事件表 | 测试保一致 |
| 19 | `NOTICE.md:17` | 文档事件表 | 测试保一致 |

**两条关键约束（从上面这张表直接推出）**：

- 第 1、2、4、5、6 条都在根 `packages/shared`，第 7、8、9 条在根 `services`/`ui`——**根包够不到 `@zcode/contracts`**（`services/src/migration/domains/hookDeclarations.ts:17-19` 的注释已明确记录这一点）。所以单源**不可能**放在 contracts。
- 第 4、5、6 条的漏改**不会编译报错**，只会让新事件在信任库解析、协议投影、审核弹窗处**运行时静默失败**；第 7、8 条的漏改会让新事件 hook 被静默丢弃。这类"静默失效"正是本任务要消灭的，必须由测试兜底。

### 1.5 zod 与测试的真实状况（修正 v1 的表述）

- **zod 版本分歧属实**：`apps/zcode-cli/packages/contracts` 解析到 **3.25.76**（自带 `node_modules/zod`），`packages/shared` / `adapters` / 根 解析到 **4.6.5**。
- **adapters 的注释版本号已过期**：`adapters/src/config/schema.ts:229` 写"adapters 4.4.3 / shared 4.3.6"，实测两者均为 **4.6.5**。本任务顺手修正该注释。
- **根因是 dts 类型泄漏（TS2742）**，属编译期问题（`adapters/src/config/schema.ts:227-233` 注释一致）；运行时 fixture 一致**测不到**它。
- **测试现状**：全仓**没有 `test` 脚本**（根与 `apps/zcode-cli` 的 `package.json` 均无）；测试文件靠手工 `node --import tsx --test <file>` 执行。`apps/zcode-cli/packages/core/tsconfig.json` **显式 `exclude: ["**/*.test.ts"]`**，`contracts/tsconfig.json` 只 `include: ["src/**/*"]`——**新增测试文件既不进 typecheck 也不进 lint**。全仓 38 个测试文件中，仅 4 个间接涉及 hook（`core/test/session-mailbox-sender-kind.test.ts`、`core/test/session-message-chain.test.ts`、`packages/services/test/dataMigration.test.ts`、`packages/services/test/identityPaths.test.ts`），确无 runner / hook-flow / configured-runner / 信任状态机的针对性用例。

---

## 2. 现状能力矩阵

| 生命周期点 | 外部命令 hook | 内部事件可订阅 | 备注 |
| --- | --- | --- | --- |
| Session 启动 | ✅ SessionStart | ✅ SessionCreated / Resumed | `runtime/methods/turn.ts:233-244`、`resume.ts:254-263` |
| 用户提交 | ✅ UserPromptSubmit | ✅ TurnStarted / InputReceived | `turn.ts:367-429`，可阻断 |
| 工具执行前 | ✅ PreToolUse | ✅ ToolCallScheduled | `tool/executor/call-runner.ts:232`（调用头） |
| 工具需审批 | ✅ PermissionRequest | ✅ PermissionRequested | `permission-flow.ts:225`，与 broker 竞速 |
| 工具成功后 | ✅ PostToolUse | ✅ ToolCallResult | `call-runner.ts:476`（调用头） |
| 工具失败后 | ✅ PostToolUseFailure | ✅ ToolCallError | `call-runner.ts:566`（调用头） |
| 回合将结束 | ✅ Stop | ✅ TurnComplete / TurnError | `turn-stop.ts:201-215`，可续跑（上限 3） |
| 子代理启动 / 停止 | ❌ | ✅ SubagentSpawned / Stopped | `subagent/runner.ts:280,526,1069` / `:398,443,1589,1667,1854` |
| 压缩前 | ❌ | ❌ | 全仓无 `PreCompact` |
| 压缩开始 | ❌ | ✅ CompactStarted | `compact-active.ts:246,650` |
| 压缩边界落库 | ❌ | ✅ CompactBoundary | `compact-active.ts:589` |
| 压缩完成 | ❌ | ✅ CompactCompleted | `compact-active.ts:227`（skipped）、`:609`（completed） |
| 压缩失败 | ❌ | ✅ CompactFailed | `compact-persistence.ts:186` |
| 会话结束 | ❌ | 🟡 `SessionEventType.SessionEnded` 仅枚举、无 append 点 | `events/session.events.ts:90` |
| 模型切换 | ❌ | ✅ Model* 系列 | 未挂 hook |

> v1 曾把 `compact-active.ts:246/650` 误标为"压缩后"。实际 246 与 650 都是 **`CompactStarted`**；`CompactBoundary` 的唯一发射点是 **589**，压缩完成点是 **227 / 609**。P1 的 `PostCompact` 必须挂 227/589/609，不能挂 246/650。

---

## 3. 设计决策

- **D1 不自造协议**。沿用 `hook_event_name` / `continue` / `decision` / `hookSpecificOutput` / `additionalContext` / `permissionDecision` 这套四家已收敛的事实标准。**明确的兼容目标：Claude Code 的 hook 脚本可平移运行**（字段名与语义以 Claude 为准，ZCode 特有扩展单独命名并在文档标注）。
- **D2 事件单源下沉到 `@zcode/shared`**。理由是可达性（§1.4）：只有 shared 同时被 CLI workspace 与根 workspace 消费。单源模块必须**浏览器安全、零运行时依赖**（UI 会 import 它），因此只放纯字符串常量与纯数据描述符，**不放 zod**。契约细节见 §5。
- **D3 穷尽性用 `satisfies` + 类型级断言，不用 `Object.fromEntries`，不引入代码生成器**。见 §5.2。理由：`Object.fromEntries` 会丢字面量键从而**取消**编译检查，正好是我们要买的东西的反面。
- **D4 本轮不动 zod 版本统一**。三处 CLI/根 schema 各自的 zod 实例保留，改为从单源派生事件键；zod 统一（把 `contracts` 升到 4.x 后删副本改 re-export）**单独立项**，因为它是依赖升级，风险与目标不同。`packages/shared/src/workspace-hook-trust-store-file.ts:3-18` 已有一段"schema 下沉 shared 做单源、CLI 侧 re-export"的先例与 zod3/zod4 实例禁忌说明，本设计沿用该先例。
- **D5 能力字段本轮不接引擎**。描述符里的 `matcherKind` / `blockable` / `injectsContext` 在 P0 是**元数据**（供 UI、文档、后续 P1 使用），**不改变现有执行语义**。任何"用能力字段驱动阻断判定"的改动都是行为变更，留到 P1 并配测试。禁止把它们当成"已经生效的约束"来宣称。
- **D6 handler 类型本轮只扩 `http` 与 `mcp_tool`**。`prompt` / `agent`（模型类 handler）需要独立模型调用与成本上限设计，暂缓。`http` / `mcp_tool` 的安全模型见 §10，**未补齐不予放行**。
- **D7 决策合并 `deny > ask > allow`（最严格获胜）仅适用于权限类字段**；且 **hook 的 `allow` 不得绕过原生权限系统的 deny**。注意现状是**逐字段**语义不同：`permissionBehavior` 取最严，而 `permissionRequestResult` / `updatedInput` / `stopShouldContinue` 是**后写覆盖**（`core/src/hooks/output.ts:81-96,145-152`）。合并规则必须先按字段列成表，不能一句"最严获胜"带过。
- **D8 默认 fail-open，安全类事件可 per-hook fail-closed**。默认值必须写进文档，不让用户猜。
- **D9 `SessionEnd` 依赖前置修复**：先给 `SessionEventType.SessionEnded` 补上 append 点，才能挂 `SessionEnd` hook。
- **D10 新事件的协议兼容须显式设计**：协议投影行 schema（`rows.ts`）与审核 schema（`workspace-hook-review.ts`）都是 `.strict()` / enum，旧客户端（desktop / web，含 `web-remote-replayable` 回放链路）会**拒收**含新事件名的行。须给出向前兼容策略（未知事件名降级投影 vs 拒收）并纳入验收。

---

## 4. 目标事件集

### 4.1 第一波（P1 实施）

| 事件 | 插入点 | 阻断能力 | 说明 |
| --- | --- | --- | --- |
| `PreCompact` | `runtime/methods/compact.ts`（manual / auto 入口）、`compact-active.ts` 主循环前 | 可阻断 | 为压缩开关化与后续"压缩前 hook"提供挂点 |
| `PostCompact` | `compact-active.ts:227 / 589 / 609`（完成与 boundary 落库后） | 仅观察 + 注入上下文 | **不得**挂 246/650（那两个是 `CompactStarted`） |
| `SubagentStart` | `subagent/runner.ts:280/526/1069` | 仅注入上下文 | |
| `SubagentStop` | `subagent/runner.ts:398/443/1589/1667/1854` | 可阻断 | 对齐 Claude 语义 |
| `SessionEnd` | 需先补 `SessionEnded` append 点（见 D9） | 仅观察 | |

### 4.2 第二波（P3，观察类）

`Notification`、`StopFailure`、`PostToolBatch`、`PermissionDenied`、`PreModelSwitch` / `PostModelSwitch`（与"模型降档提前压"配套）。

### 4.3 第三波（评估，视 ZCode 场景取舍）

`TaskCreated` / `TaskCompleted`、`FileChanged`、`ConfigChange`、`InstructionsLoaded`、`CwdChanged`、`Elicitation`。逐个评估后再定。

### 4.4 matcher 维度（每个事件需要声明）

现有实现按工具名匹配（`hookMatcherToolNamesForTool`）。新事件各自的匹配维度在描述符 `matcherKind` 里声明：`SessionStart` → `source`（startup/resume/clear/compact），`PreCompact` → `compactTrigger`（manual/auto），子代理事件 → `subagent`。**matcher 字符串语义（纯词精确 / 含特殊字符走正则 / `*` 全匹配）需在 P0 核实并对齐 Claude**（见 §11 未决项）。

---

## 5. 单源与派生（本设计的核心）

### 5.1 单源位置与形状

**位置**：`packages/shared/src/hooks.ts`（该文件已存在，当前只放 `HookEvent` 联合与 UI 类型）。

**要求**：该模块必须**浏览器安全**（UI 直接 import），因此**零 `node:*` 依赖、零 zod、零跨模块副作用**。描述符只含纯数据。

```ts
// packages/shared/src/hooks.ts —— 唯一权威来源
export const HOOK_EVENT_NAMES = [
  "SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest",
  "PostToolUse", "PostToolUseFailure", "Stop",
] as const;

export type HookEvent = (typeof HOOK_EVENT_NAMES)[number];

export interface HookEventDescriptor {
  /** matcher 的匹配维度 */
  matcherKind: "toolName" | "sessionSource" | "compactTrigger" | "subagent" | "none";
  /** 能力元数据（P0 不接引擎，见 D5） */
  blockable: boolean;
  injectsContext: boolean;
  /** 设置页标签的 i18n key */
  labelKey: string;
}

export const HOOK_EVENT_DESCRIPTORS: Record<HookEvent, HookEventDescriptor> = {
  SessionStart: { matcherKind: "sessionSource", blockable: false, injectsContext: true, labelKey: "settings.hooks.event.sessionStart" },
  /* …7 项穷尽… */
};
```

**穷尽性来源**：`Record<HookEvent, HookEventDescriptor>` —— 单源里少一个事件即编译报错；新增事件时这个 `Record` 会强制你填写描述符，而这个事件名同时会传播到下面所有站点。

**刻意不放进描述符的东西**（v1 放了，评审判定为投机抽象）：
- ~~`specificOutputSchema: () => z.ZodTypeAny`~~ —— zod 实例绑定（shared 是 zod4、contracts 是 zod3），且 `ZodTypeAny` 无法满足 `z.discriminatedUnion` 的判别式成员约束，必然 `as` 强转，等于放弃编译保证。
- ~~`inputExtrasSchema`~~ —— 全仓**不存在**运行时输入校验（`HookInput` 只有 TS 类型，见 `contracts/src/hooks/index.ts:141-148`），放进描述符要么是死代码要么是新增行为。
- ~~`labelEn` / `docsNote`~~ —— 英文标签归 i18n 文件；文档由测试保一致（§5.5），不靠描述符生成 markdown。

### 5.2 派生规则（保字面量 + 保穷尽）

每个拥有 zod 实例的包**各自**从单源构造本包 schema，用**键控映射 + `satisfies`**，而不是 `Object.fromEntries`：

```ts
import { HOOK_EVENT_NAMES, type HookEvent } from "@zcode/shared";
const eventsMap = {
  SessionStart: z.array(hookMatcherSchema).optional(),
  /* …每个键显式写出… */
} satisfies Record<HookEvent, z.ZodTypeAny>;   // ← 少一个/多一个 → 编译错误
const events = z.object(eventsMap).strict();    // ← 保留字面量键，z.infer 精确
```

这样同时拿到三件事：**穷尽性编译错误**、**字面量键**（`z.infer` 与 `.strict()` 行为不变，故 D5 的"不改行为"成立）、**zod3 / zod4 通用**。

CLI 侧（zod3）的 `use…` 与根侧（zod4）同形，只是各自 import 各自的 zod。

**契约包对单源的引用方式**：`apps/zcode-cli/packages/contracts` 依赖 `@zcode/shared`（`workspace:*`），直接 import 名字常量与类型即可；**只派生名字与键，不嵌入 shared 的 zod 对象**（遵守 `workspace-hook-trust-store-file.ts:16-17` 记录的 zod3/zod4 禁忌）。

### 5.3 类型级穷尽断言（覆盖手写联合与 switch）

描述符管不到的站点用类型级断言兜底，成本是几行类型别名：

```ts
// 每个 HookEvent 都必须在 HookSpecificOutput 里有成员
type _AssertSpecificOutputExhaustive =
  HookEvent extends HookSpecificOutput["hookEventName"] ? true : never;
const _checkSpecificOutput: _AssertSpecificOutputExhaustive = true;

// 同理覆盖 HookInput
type _AssertHookInputExhaustive =
  HookEvent extends HookInput["hookEventName"] ? true : never;
const _checkHookInput: _AssertHookInputExhaustive = true;
```

`switch (hookEventName)` 站点（`configured-runner-input.ts:39`、`output.ts:118`、`product-projection.ts:1747`）补 `default: assertNever(hookEventName)`（该函数在 core 已有或按 3 行实现）。

### 5.4 副本语义分歧（v1 声称"等价"，实际不等价）

三处 schema 今天在**同一字段**上判定不同，必须先列成矩阵、逐条决定"收敛"还是"有意为之"，**不得**再宣称等价：

| 字段 | `contracts`（zod3，RPC patch） | `shared` / `adapters`（zod4，配置文件） | 处置 |
| --- | --- | --- | --- |
| 未知字段 | strip（无 `.passthrough()`） | `passthrough` | **待定**：RPC patch 与文件装载语义不同，可能是有意；P0 核实后写结论 |
| `timeoutMs` | `z.number().int().positive()` | `z.number().finite().positive()` | **收敛**（`.finite()` 在 zod4 已是 no-op，`int()` 更严；两者对 `1.5` 判定相反） |
| `statusMessage` | `z.string().optional()` | `z.string().min(1).optional()` | **收敛**（对空串判定相反） |
| matcher 对象 | 非 strict | `.strict()` | **待定** |

**P0 的等价性测试必须写成"事件键集合相等 + 上表每个轴的显式 accept/reject 契约"**，而不是"三方判定处处一致"——后者按现状会当场红，且即使绿也证明不了 TS2742 那一面。

### 5.5 文档一致性（替代"文档表由描述符派生"）

markdown 不参与编译。改为一个**测试**：读取 `apps/zcode-cli/README.md` 与 `NOTICE.md` 的事件段，正则抽出事件名清单，断言其与 `HOOK_EVENT_NAMES` 集合相等。这是"加假事件会失败"的验收项里，文档那一部分唯一可兑现的形式。

---

## 6. 所有权与不变式

1. **唯一执行者**：hook 真实执行只在 `apps/zcode-cli/packages/core`。根 workspace（`packages/*`）只做配置、发现、信任、UI、协议投影，**不得**执行 hook（已确认根包无 `InMemoryHookRunner` / `createConfiguredHookRunner` / `runPreToolUseHooks` 命中）。
2. **准入每 dispatch 重算**：`core/src/hooks/runner.ts:66-111` 在每个 hook 派发前重新解析准入。不变式：`revoke` 或策略收紧**不得**被缓存绕过。
3. **信任与声明分离**：声明可随仓库/插件分发；信任状态只由用户授权，带 `hookDeclarationDigest`，声明变更即 `stale_digest`；信任库损坏一律 fail-closed（`services/src/hooks/hooksService.ts:132-207`）。
4. **hook 不得扩权**：`allow` 不能绕过 settings 的 deny；`alwaysAsk` 的确认不能被 hook 静默放行（`tool/executor/hook-flow.ts:201-203`）；hook 返回的 `updatedInput` 必须重新走校验（`call-runner.ts:269-276`）。
5. **单源在 shared，且必须浏览器安全**：事件名单一来源是 `packages/shared/src/hooks.ts`，含零 `node:*` / 零 zod 约束。任何把描述符挪回 CLI workspace、或往描述符里塞 zod 工厂的改动，都会破坏"根侧可派生"，属设计回退。
6. **声明必须计入信任摘要**：`packages/shared/src/workspace-hook-digest.ts:74` 遍历 `WORKSPACE_HOOK_EVENT_NAMES` 计算 `bundleDigest`。新事件若不进入该列表，其声明**不计入信任摘要**（信任了却不受控），故单源派生是信任边界的一部分，不是纯重构。
7. **身份与数据根**：hook 配置与信任库随产品身份隔离（`CONTEXT.md:64`、`packages/services/spec/workspace-hook-trust-location.md`）。扩充事件不改变这一归属。

---

## 7. 失败语义

| 情形 | 语义 | 实现位置 |
| --- | --- | --- |
| 退出码 `2` | 显式 block / deny；stderr 作为原因 | `core/src/hooks/configured-runner-callback.ts:127-129`、`:195-238` |
| 其它非零退出 | 非阻断错误：记录、提示，**不中断 turn** | `configured-runner-callback.ts:131-152`（`recoverable: true`） |
| stdout 非法 JSON | 非阻断错误，不采信该输出 | `configured-runner-callback.ts:165-193` |
| 超时 | 默认 60000ms（`DEFAULT_WORKSPACE_HOOK_TIMEOUT_MS`）；阻断类事件超时是否阻断由 per-hook `failClosed` 决定，默认 fail-open | `shared/src/workspace-hook-config.ts:7` |
| 输出超限 | 默认 32768 bytes（`DEFAULT_WORKSPACE_HOOK_MAX_OUTPUT_BYTES`），超限截断并标记 `truncated` | `shared/src/workspace-hook-config.ts:8` |
| 同一事件多个 hook | 现存实现为组内**逐条**执行；目标语义待定（§11 未决项 2） | `runner.ts:82` |
| `continue: false` | 硬停止后续流程；`Stop` 事件的续跑上限 3 | `runtime/methods/hooks.ts:10,119-128` |

> v1 把"其它非零退出"记到 `:195-238`，实际那段是退出码 2 的 `createExitCodeBlockOutput`；已按上表更正。

---

## 8. 迁移边界与兼容

- **新增事件不改变已有 7 个事件的行为**；不配置新事件即无新行为。
- **新增字段缺省即旧行为**：`once` / `failClosed` / `http` / `mcp_tool` 全部缺省关闭或不存在。
- **P0 不改运行时判定语义**（见 D5）：只改"事件键怎么来的"与"文档/注释怎么说"，不改任何一处 `if (hookEventName === …)` 的结果。
- **配置合并语义变更**（P3，各层分别读取 → 三层合并，user < project < managed）**是行为变更**，需要单独的兼容说明与回归验证；落地前不得悄悄改动读取顺序。
- **新事件的协议向前兼容**（D10）：新事件名进入 `rows.ts` / `workspace-hook-review.ts` 的 enum 后，旧客户端行为需明确定义（降级投影 vs 拒收），并覆盖 `web-remote-replayable` 回放链路。
- **zod 版本统一不在本轮**；统一工作单独立项，验收标准是"删除 `adapters/src/config/schema.ts:227-284` 副本改 re-export 且 `pnpm typecheck:cli` 通过"。
- **`SessionEnded` 事件追加点**只新增事件，不改变现有会话终止语义。
- **身份迁移边界不变**：hooks 声明参与迁移（按事件 + matcher 合并），**信任不迁移**（`packages/services/src/migration/domains/hookDeclarations.ts`、`identity-data-migration.md:39,112,163` 已定）。注意该迁移域自带第 8 份事件名白名单，P0 必须一并派生，否则新事件在迁移时被判"未知 hook 事件，跳过"。
- **插件兼容**：`hooks/hooks.json` 与 manifest `hooks` 字段的发现逻辑不变；插件声明了不支持的事件时继续发 `plugin_hook_unsupported_event` 警告（`adapters/src/plugins/hook-sources.ts:130-135`、`contracts/src/plugins/index.ts:41`）。

---

## 9. 未决项（P0 需核实后固化）

1. **matcher 字符串语义**：现状按工具名的何种规则匹配（精确 / 前缀 / 正则）？是否支持 `*` 与 `|`？草拟对齐 Claude：纯 `[A-Za-z0-9_-]` 精确，含其它字符视为未锚定正则，`*`/空全匹配。核实后写回本节。
2. **同组 hook 的执行模型**：现有 `runner.ts` 逐条执行，且该顺序**承载准入重算窗口**（§6.2 不变式）：逐条 dispatch 前重算准入，正是让"前序 hook 运行期间的 revoke / 策略收紧"对后续 hook 生效的机制。改为并行会**抹掉这个窗口**，与 §6.2 冲突。是否改并行需作为**安全相关变更**单独评审，并说明新模型下如何保持该不变式。`configured-runner.ts:174-191` 定义了 user/project/plugin 的插入顺序，改动需评估是否保留顺序保证。
3. **`PostToolBatch` 是否纳入本轮**：ZCode 是否有并行工具批次概念未核实。
4. **`Notification` 的通知源定义**：ZCode 的通知来源（权限弹窗、错误、后台任务完成）需先盘点，否则事件没有明确触发点。
5. **`if` 字段语义**：v1 已把 `if` 列进 P3 验收表却未给语义。要么补设计，要么在 P3 明确不实现。
6. **描述符副本的处置**：§5.4 的四个分歧轴，哪些收敛、哪些标注为有意为之。
7. **`once` 的状态所有权**：状态存哪（内存 / 磁盘）、跨 resume 是否重置、是否随身份隔离。

---

## 10. 安全模型（`http` / `mcp_tool`，P2 前置）

v1 只给了字段表。`http` 与 `mcp_tool` 引入了新的**出网**与**凭据外带**面，P2 开工前必须补：

- **SSRF 防护**：禁止回环 / 链路本地 / 云 metadata 地址；重定向策略（是否跟随、跟随几次）。
- **凭据处理**：`headers` 值支持 `$ENV_VAR` 是明确的凭据外带面——需定义 `allowedEnvVars` 默认白名单、日志与诊断中的脱敏规则。
- **响应体**：大小上限、非 JSON 处理、超限行为。
- **MCP 调用的权限归属**：hook 调用的 MCP 工具**是否重新进入原生权限 broker**。若不进入，就是"hook allow 绕过原生策略"的新路径（违反 §6.4）。
- **并发与阻塞**：默认 fail-open + 60000ms 意味着一个挂死的网络 hook 可卡住单个 turn 60 秒；需定义并发上限与是否允许后台化。

未补齐本节内容前，P2 不予放行。
