# Hook 框架通用型扩充 · 实施方案

- 状态：**v2，已按无上下文评审修订**
- 配套设计规格：`apps/zcode-cli/packages/core/spec/hook-framework-expansion.md`（契约、不变式、失败语义、单源设计以它为准；本文件只讲施工顺序与验收）
- 目标:对齐业界事实标准（Claude Code 为标杆），把"加一个事件"的成本压到一处，并为压缩 hook、子代理 hook 铺路
- 开工前跑 `node scripts/check-workspace-freshness.mjs` 检查基线

---

## 0. v1 → v2 修订（评审结论）

v1 的 P0 被评审判定**不能开工**，四项前提与代码事实不符：

1. v1 把单源放在 CLI 的 `contracts`，但 `ui` / `services` / `packages/shared` 都不依赖它 → **单源改到 `packages/shared/src/hooks.ts`**。
2. v1 用 `z.object(Object.fromEntries(...))` 生成 schema，会丢字面量键从而取消编译检查 → **改用键控映射 + `satisfies Record<HookEvent, …>`**。
3. v1 只列了 6 处改动，实际有 **19 个文件**枚举事件名，其中 6 处漏改会**静默失效**（不报错） → **P0 清单按下表补全**。
4. v1 宣称"三份 schema 等价"且"P0 零行为变化" → 三份 schema 今天已有真实分歧（§5.4 矩阵），P0 只做"键集合派生 + 类型级守卫 + 测试"。

另外修正了 v1 的测试与门禁认知：全仓**没有 `test` 脚本**，`core/tsconfig.json` 显式 `exclude ["**/*.test.ts"]`，`contracts/tsconfig.json` 只 `include ["src/**/*"]` —— **新测试既不进 typecheck 也不进 lint**，P0 必须先解决测试入口。

---

## 1. 决策记录（已确认）

| 编号 | 决策 | 结论 |
| --- | --- | --- |
| 1 | P0 范围 | **先做地基**：单源 + 全量派生 + 类型级穷尽守卫 + 测试入口 + 文档修正。不先上具体事件 |
| 2 | 单源位置 | `packages/shared/src/hooks.ts`（浏览器安全、零 zod、零 `node:*`） |
| 3 | 穷尽机制 | 键控映射 + `satisfies Record<HookEvent, …>`；手写联合用类型级断言；switch 加 `assertNever`。**不用** `Object.fromEntries`，不引代码生成器 |
| 4 | handler 类型 | 本轮只扩 `http` + `mcp_tool`；`prompt` / `agent` 暂缓（需独立模型调用与成本上限） |
| 5 | SessionEnd 前置 | 纳入 P1，一并补 `SessionEventType.SessionEnded` 的 append 点 |
| 6 | 兼容目标 | 明确以"Claude Code hook 脚本可平移"为目标（字段名与语义以 Claude 为准） |
| 7 | 能力字段 | P0 内 `matcherKind` / `blockable` / `injectsContext` 仅作元数据，**不接引擎**（接引擎是 P1 的行为变更，须配测试） |
| 8 | zod 统一 | 单独立项；P0 只加类型级守卫与键集合测试 |

---

## 2. 分期总览

| 期 | 内容 | 是否改变行为 |
| --- | --- | --- |
| **P0** | 单源下沉 + 19 站点派生 + 类型级穷尽守卫 + 测试入口 + 键集合/文档一致性测试 + 现有 7 事件基线测试 + 注释与 README 修正 | 否（除注释与测试基建） |
| **P1** | 第一波事件：PreCompact / PostCompact / SubagentStart / SubagentStop / SessionEnd（含 `SessionEnded` append 点）+ 能力字段接引擎 | 是（新增事件，缺省无影响） |
| **P2** | handler 类型：`http` + `mcp_tool`（**前置：§10 安全模型补齐**） | 是（缺省无影响） |
| **P3** | 协议补全（`updatedToolOutput` / `once` / `failClosed`）+ 第二波观察类事件 + 配置三层合并语义 | 是（合并语义需单独兼容说明） |
| **P4** | 插件样例（`hooks/hooks.json`）+ 文档与示例 + 信任 CLI 文档 | 否 |

---

## 3. P0 改动清单（本轮提交范围）

### 3.1 新建

**`packages/shared/src/hooks.ts`（改造现有文件）** —— 事件单一来源。

```ts
export const HOOK_EVENT_NAMES = [ /* 7 项 as const */ ] as const;
export type HookEvent = (typeof HOOK_EVENT_NAMES)[number];
export interface HookEventDescriptor {
  matcherKind: "toolName" | "sessionSource" | "compactTrigger" | "subagent" | "none";
  blockable: boolean;
  injectsContext: boolean;
  labelKey: string;
}
export const HOOK_EVENT_DESCRIPTORS: Record<HookEvent, HookEventDescriptor> = { /* 穷尽 */ };
```

约束：该模块**零 `node:*`、零 zod**（UI 会 import，见规格 §5.1 不变式 5）。

**`apps/zcode-cli/packages/contracts/src/hooks/event-exhaustiveness.ts`（或就近）** —— 类型级断言，覆盖 `HookSpecificOutput` / `HookInput` 联合的穷尽性（规格 §5.3）。

**测试入口（P0 必须先解决）**：全仓无 `test` 脚本，且两个 tsconfig 都不覆盖测试文件。二选一：
- (a) 在根与 `apps/zcode-cli` 各加一个 `"test": "node --import tsx --test ..."` 脚本（UI 侧沿用 `TSX_TSCONFIG_PATH`），并把 `**/*.test.ts` 纳入 typecheck（或新增 `tsconfig.test.json`）；
- (b) 若不改门禁，则在方案里明确写出运行命令与"测试文件不在 typecheck 覆盖内"这一事实，验收时手工执行。

**推荐 (a)**：否则"加假事件 → 测试失败"这条验收没有可执行载体。

### 3.2 修改 —— 全量派生（19 站点，按规格 §1.4 编号）

| # | 文件 | 改动 |
| --- | --- | --- |
| 1 | `packages/shared/src/hooks.ts:4-11` | **单源本体**（`HookEvent` 由 `HOOK_EVENT_NAMES` 派生） |
| 2 | `packages/shared/src/workspace-hook-config.ts:9-17` | `WORKSPACE_HOOK_EVENT_NAMES` 改为 re-export / 派生自单源（消除同名双份） |
| 3 | `packages/shared/src/workspace-hook-config.ts:67-78` | schema `events` 键改键控映射 + `satisfies` |
| 4 | `packages/shared/src/workspace-hook-trust-store-file.ts:22-31` | enum 派生自单源 |
| 5 | `packages/shared/src/zcode-protocol-v4/rows.ts:310-318` | `hookEventName` enum 派生 |
| 6 | `packages/shared/src/zcode-protocol-v4/workspace-hook-review.ts:114-122` | review item `event` enum 派生 |
| 7 | `packages/services/src/hooks/hooksService.ts:37-45` | `HOOK_EVENTS` 派生（该文件已 import `@zcode/shared`） |
| 8 | `packages/services/src/migration/domains/hookDeclarations.ts:25-33` | `HOOK_EVENT_NAMES` 派生（其注释已写明不能依赖 contracts —— 正因如此单源必须在 shared） |
| 9 | `packages/ui/src/settings/HookForm.tsx:35-43` | 下拉源派生（已 import `@zcode/shared` 的 `HookEvent`） |
| 10 | `apps/zcode-cli/packages/contracts/src/hooks/index.ts:7-15` | `HookEventName` 派生（保留对象形态以供 `z.literal` 使用） |
| 11 | `apps/zcode-cli/packages/contracts/src/hooks/index.ts:163-194, 248-280` | 成员手写 + 类型级穷尽断言（§3.1 新文件） |
| 12 | `apps/zcode-cli/packages/contracts/src/hooks/index.ts:411-422` | patch `events` 键改键控映射 + `satisfies` |
| 13 | `apps/zcode-cli/packages/contracts/src/hooks/workspace-hook-trust.ts:9-17, 188-196` | 字段表 + enum 派生 |
| 14 | `apps/zcode-cli/packages/adapters/src/config/schema.ts:272-282` | `events` 键派生；**同时修正 `:229` 过期注释**（"4.4.3 / 4.3.6" → 实测两者均 4.6.5） |
| 15 | `apps/zcode-cli/packages/core/src/hooks/configured-runner-input.ts:39-60` | switch 加 `assertNever` |
| 16 | `apps/zcode-cli/packages/core/src/hooks/output.ts:118-160` | switch 加 `assertNever`；硬编码集合改派生 |
| 17 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts:1622,1658,1747-1750` | lane / 挂载判断加穷尽兜底（真正的语义补齐留 P1，但 P0 必须让它**可被发现**） |
| 18 | `apps/zcode-cli/README.md` | 修正 `type` 支持范围（`:255` 现写"currently only `process` is supported"，实际已支持 `command`）+ 事件表 |
| 19 | `NOTICE.md:17` | 事件表 |

> 站点 17、18、19 在 P0 里**不可能**产生编译错误（一个是运行时 lane 逻辑，两个是 markdown）。它们由 §3.3 的测试兜底，这点必须在验收里说清，不能假装"处处报错"。

### 3.3 测试

**新建**（路径遵循仓库惯例 `packages/<pkg>/test/*.test.ts`）：

- `packages/shared/test/hook-event-descriptors.test.ts` —— 描述符完整性：每个事件有非空 `labelKey` 与合法能力声明；`HOOK_EVENT_NAMES` 与 `HOOK_EVENT_DESCRIPTORS` 键集合相等。
- `packages/shared/test/hook-event-copy-parity.test.ts` —— **全量副本键集合相等**：对多份 schema / 白名单喂非法事件名 fixture，断言**每一份都拒绝**；喂全部合法事件名，断言**每一份都接受**。这是站点 3/4/5/6/12/13/14 的硬门槛。
   > 注意：这里只测**事件键集合**，不测"字段语义等价"——后者按规格 §5.4 存在真实分歧，另在 `hook-schema-divergence.test.ts` 里逐轴写成 accept/reject 契约。
- `packages/shared/test/hook-schema-divergence.test.ts` —— 规格 §5.4 的四个分歧轴（未知字段 / `timeoutMs` / `statusMessage` / matcher 严格性）各一组 fixture，断言**当前预期行为**（收敛了就断言"三方一致"，标注为有意为之的断言"各自行为"）。
- `packages/shared/test/hook-doc-consistency.test.ts` —— 读 `apps/zcode-cli/README.md` 与 `NOTICE.md`，正则抽事件清单，断言与 `HOOK_EVENT_NAMES` 集合相等（规格 §5.5）。
- `apps/zcode-cli/packages/core/test/hook-runner.test.ts` —— 现有 7 事件基线：matcher 命中/不命中、exit 2 阻断、非零退出不阻断、超时、输出截断、`additionalContext` 注入、`alwaysAsk` 不被静默放行。
- `apps/zcode-cli/packages/core/test/hook-flow.test.ts` —— 工具链路四个事件的挂载点与决策合并；**逐字段**记录 `deny > ask > allow` 与"后写覆盖"的现行结果（规格 D7）。

### 3.4 P0 验收

1. **穷尽性可证伪**：在单源 `HOOK_EVENT_NAMES` 里加一个假事件，然后逐项确认：
   - 产生**编译错误**：单源 `Record`、各站点 `satisfies`、类型级断言、`assertNever`（站点 1-16 中的类型化站点）；
   - 产生**测试失败**：副本键集合测试、描述符完整性测试、文档一致性测试（覆盖站点 17-19 这类无法编译期捕获的）。
   把实际失败清单记进 PR，作为"约束真的生效"的证据。
2. 全量副本键集合测试通过。
3. 现有 7 事件契约测试通过，且运行时判定语义**零变化**（D5）。
4. `pnpm typecheck`、`pnpm lint`、`pnpm typecheck:cli` 通过（不追 `apps/zcode-cli` 既存 lint/format 红债）。
5. 测试入口可执行（§3.1 的 (a) 或 (b)）。

---

## 4. P1 要点（第一波事件）

| 事件 | 落点 | 能力 |
| --- | --- | --- |
| `PreCompact` | `runtime/methods/compact.ts`（manual / auto 入口）+ `compact-active.ts` 主循环前 | 可阻断 |
| `PostCompact` | `compact-active.ts:227 / 589 / 609`（**非** 246/650，那两个是 `CompactStarted`） | 仅观察 + 注入 |
| `SubagentStart` | `subagent/runner.ts:280/526/1069` | 仅注入 |
| `SubagentStop` | `subagent/runner.ts:398/443/1589/1667/1854` | 可阻断 |
| `SessionEnd` | 前置：给 `SessionEventType.SessionEnded`（`events/session.events.ts:90`）补 append 点，再挂 hook | 仅观察 |

每个事件都要同步：单源描述符、`HookInput` 联合与类型级断言、`HookSpecificOutput` 成员、插入点、`product-projection.ts` 的 lane / 挂载逻辑、i18n 标签、README/NOTICE、契约测试。

P1 同时落地：`blockable` / `injectsContext` 从"元数据"接进引擎判定（规格 D5），并补测试证明不可阻断事件的 exit 2 被正确忽略。

---

## 5. P2 / P3 UI 规格（照此施工）

设置页表单在 `packages/ui/src/settings/HookForm.tsx`，文案在 `packages/ui/src/i18n/locales/{zh-CN,en-US}.ts`。

> **前置**：P2 开工前必须先补齐规格 §10 的安全模型（SSRF / 凭据脱敏 / MCP 是否过权限 broker / 并发上限），否则不予放行。

### 5.1 handler 类型选择器（P2）

- 现状：类型下拉只有 `process` / `command`。
- 改为四个选项：`command`（Shell 命令）、`process`（可执行文件）、`http`（HTTP 请求）、`mcp_tool`（MCP 工具）。
- 选中 `http` 时展示字段：`url`（必填，URL 校验）、`headers`（键值对编辑器，值支持 `$ENV_VAR`）、`allowedEnvVars`（字符串标签组）。
- 选中 `mcp_tool` 时展示：`server`（下拉，取自已配置 MCP server）、`tool`（下拉，选自该 server 的工具）、`input`（JSON 编辑器，带语法校验）。
- 状态：`server` / `tool` 依赖已配置 MCP；若无可选项，显示空态「尚未配置 MCP 服务器，请先在 MCP 设置中添加」并禁用保存。
- 文案：
  - `settings.hooks.type.http` = 「HTTP 请求」/ "HTTP request"
  - `settings.hooks.type.mcpTool` = 「MCP 工具」/ "MCP tool"
  - `settings.hooks.http.url` = 「请求地址」/ "URL"
  - `settings.hooks.mcpTool.server` = 「MCP 服务器」/ "MCP server"

### 5.2 行为开关（P3）

在 handler 行内加两个开关：

| 控件 | 中文 / 英文 | 描述文案 | 默认 |
| --- | --- | --- | --- |
| Switch | 仅执行一次 / Run once | 「本次会话只执行一次，之后不再触发」/ "Run once per session" | 关 |
| Switch | 失败时阻断 / Fail closed | 「脚本崩溃或超时时阻断该操作（默认不阻断）」/ "Block the action when this hook fails or times out" | 关 |

状态：`failClosed` 在事件不可阻断（描述符 `blockable: false`）时禁用并提示「该事件不支持阻断」。`once` 的状态所有权见规格 §11 未决项 7。

### 5.3 事件下拉

从 `HOOK_EVENT_NAMES` 派生，**不得再硬编码**；每个选项的标签取描述符 `labelKey` 的 i18n 文案（需同步在 `zh-CN.ts` / `en-US.ts` 补 key，否则中文界面会露出 key 原文）。新增事件时下拉自动出现。

---

## 6. 验收与门禁

- 门禁：`pnpm typecheck`、`pnpm lint`、`pnpm typecheck:cli`；`apps/zcode-cli` 的既有 lint/format 红债不在本轮处理。
- 测试入口：见 §3.1，P0 必须先落地（否则验收 1 无法执行）。
- 交互改动（UI 表单、事件下拉）需要 E2E 场景：在设置页配置一个新事件的 hook → 会话中触发 → 观察执行与阻断结果。
- 每期结束跑一遍 hook 契约测试与副本键集合测试；P3 的配置合并语义变更需要单独的回归验证与兼容说明。

---

## 7. 风险

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 新增事件在根 workspace 侧漏改（站点 4-9） | 信任摘要漏算、协议投影拒收、hook 被静默丢弃，**均不报错** | P0 的单源放在 shared + 副本键集合测试是硬门槛 |
| 类型级断言被后人当作样板删掉 | 穷尽性静默失效 | 断言旁写注释说明用途；副本测试兜底 |
| 三份 schema 的语义分歧被误当"已等价" | 同一配置在不同路径判定不同 | §5.4 显式矩阵 + `hook-schema-divergence.test.ts` |
| 配置三层合并语义变更 | 现有用户配置生效顺序改变 | 放 P3，单独兼容说明 + 回归；落地前不改读取顺序 |
| 并行执行模型变更 | 抹掉准入重算窗口（违反不变式 §6.2） | 作为安全相关变更单独评审（规格 §11 未决项 2） |
| `http` / `mcp_tool` 引入 SSRF 与凭据外带 | 安全边界扩大 | 规格 §10 补齐前 P2 不放行 |
| 新事件破坏旧客户端回放 | `web-remote-replayable` 拒收含新事件名的行 | D10 的向前兼容策略 + 回放链路验证 |
| zod 统一被误当作本任务一部分 | 范围膨胀、依赖升级风险 | 单独立项 |

---

## 8. 遗留与归属

**本轮范围（P0）之外、但已规划的**：P1 事件与能力字段接引擎、P2 handler 类型（含安全前置）、P3 协议补全与配置合并语义、P4 插件样例与文档。

**单独立项（明确不在本任务）**：

- zod 版本统一（`contracts` 3.25.76 → 4.x），验收标准是删除 `adapters/src/config/schema.ts:227-284` 副本改 re-export 且 `pnpm typecheck:cli` 通过。
- `prompt` / `agent` 模型类 handler（需要独立模型调用与成本上限设计）。

**需先核实再定（规格 §11）**：matcher 字符串语义、同组 hook 执行模型（并行会与不变式 §6.2 冲突）、`PostToolBatch` 是否纳入、`Notification` 通知源盘点、`if` 语义、§5.4 分歧轴处置、`once` 状态所有权。
