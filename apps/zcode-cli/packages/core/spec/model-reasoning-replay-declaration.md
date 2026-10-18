# 模型推理回放声明（Model Reasoning Replay Declaration）

涉及包：`shared`（`model-config` schema）、`contracts`（`ModelPropertiesData` / `ModelOptionSpecsData` infer 下游）、`adapters`（assistant 序列化与历史归一化）、`core`（流式推理落库）、`bootstrap`/`cli`（协议字段透传）、`ui`（模型配置表单）。

与既有 spec 的关系：本文只新增「推理回放」这一个模型级能力声明，不改动 `reasoningLevel` / `maxOutputTokens` 的既有量纲语义，不改动 Anthropic 协议的 thinking block 回放路径，不触碰上下文压缩、hook、子代理各篇结论。

状态：**待实现**（2026-10-18 立项；2026-10-19 依据本机实机轨迹修正事实认定）。

## 背景与问题

### 已核实的事实（2026-10-19 复核，附证据）

前一轮调查曾得出「ZCode 不回传 `reasoning_content`」的结论，**该结论错误，已推翻**。实测证据如下：

1. **SDK 发送侧支持回放**。`node_modules/@ai-sdk/openai-compatible/dist/internal/index.mjs:157-163`：

   ```js
   messages.push({
     role: "assistant",
     content: toolCalls.length > 0 ? text || null : text,
     ...(reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
     tool_calls: toolCalls.length > 0 ? toolCalls : void 0,
     ...metadata,
   });
   ```

   assistant 消息内只要有非空 reasoning part，SDK 就会输出 `reasoning_content`（`:130-131` 负责把 reasoning part 累加进该变量）。

2. **ZCode 确实把推理内容保存并随请求发出**。本机 `~/.zcode-rayn/cli/rollout/model-io-*.jsonl` 的 `request.messages` 中，assistant 消息普遍带 `{ type: "reasoning", text: "..." }` 块，形如 `[reasoning:12672+text:79 +toolCalls,...]`。请求体同时启用思考：`thinking: {"type":"enabled"}`、`reasoning_effort: "high"`。

   即：**「不支持推理回放」不成立，常见链路是通的。**

3. **ZCode 存在唯一一处会丢推理块的判定**。`core/src/runtime/methods/turn-output-token-continuation.ts:133-137`：

   ```ts
   export function hasAssistantReasoningContent(reasoning): boolean {
     return reasoning.text.length > 0 || Object.keys(reasoning.providerOptions ?? {}).length > 0;
   }
   ```

   文本为空**且**无 `providerOptions` 的推理块会被过滤掉。流式落库路径 `core/src/runtime/methods/turn-model-step.ts:424`（partial 快照）与 `:597`（最终结果）都用该判定过滤后才写会话历史。对 openai-compatible，推理块通常不携带 `providerOptions`，因此**文本为空的推理块必然被丢弃**。

4. **偶发性的可取证据**：本机留存的三份轨迹显示，40 次连续请求成功，且其中存在无推理块的 assistant 消息（`content: ""` + toolCalls，对应响应 `reasoning=undefined`），说明「历史中部分 assistant 消息缺推理」本身**不足以**触发上游 400——上游对该形态是容忍的。因此触发条件是一类更窄的、会**剥离某条本该有推理的消息**的事件。

   唯一已知的剥离点即第 3 条。候选触发事件（**未坐实**）：推理流被中断/未投递导致 `getOrCreateReasoningBlock` 建了空块后没有 delta；上下文压缩重写历史；会话内切换模型。

### 观察到的报错

某会话某轮请求被上游驳回：

```
Upstream request failed: [invalid_request_error]
The `reasoning_content` in the thinking mode must be passed back to the API.
provider=opencode-go-chat provider_code=invalid_request_error model=deepseek-v4.1-flash
reason=invalid_request status=400 retryable=false
```

**该请求的原始轨迹已不可恢复**：`cli/rollout` 只保留 3 个文件（`runner-debug.ts:34` `MAX_ROLLOUT_FILES = 3`），失败会话的文件已被轮转删除；其 requestId / traceId 全库检索仅命中当前会话自身的产物（用户在本会话贴过该报错文本）。因此**无法在落库数据上坐实具体命中路径**。

### 问题

1. **无模型级声明**：`packages/shared/src/model-config.ts` 的 `modelOptionSpecsDataSchema` 只有 `reasoningLevel`（开哪些档位 + `map` DSL 改请求参数）与 `maxOutputTokens`，不涉及回放。用户无法告知 ZCode「这个模型走 OpenAI Chat Completions 且要求回传上一轮思考」。
2. **剥离点无豁免**：`hasAssistantReasoningContent` 对空文本块一律丢弃，没有「该模型声明了回放，别丢」的出口。
3. **失败不可诊断**：模型 I/O 轨迹只保留 3 个会话文件，偶发失败一旦发生，证据随下次轮转消失。
4. **嗅探不可行**：opencode 用 `modelID.includes("deepseek")` 判断 `requireReasoning`（`packages/ai/src/providers/deepseek.ts`）。中转站改模型名即失效——用户自己知道在连什么，决策权应显式交给用户。

## 设计决策

### D1：声明挂在 `modelPropertiesData`，而非 `optionSpecs`

```ts
export const completeModelReasoningReplayDataSchema = z
  .object({
    field: z.enum(["reasoning_content", "reasoning", "reasoning_text"]),
    required: z.boolean(),
  })
  .strict();
```

`modelPropertiesDataSchema` 同步加 `reasoningReplay: ...nullable().optional()`。

理由：这是**该模型的能力/协议事实**（字段名、缺了是否报错），不随用户每轮选择变化；`ModelPropertiesData` 已被 `contracts` 直接 infer（`apps/zcode-cli/packages/contracts/src/model/model.ts:23`），加字段自动贯通协议层。

这条同时回答「自行选择 Provider 类型」：用户不是在选 Provider 类型，而是在**模型属性**上勾选「此模型要求回传推理内容」；Provider kind 仍由现有模板/自定义配置决定。

### D2：字段名用枚举，不开放自由输入

SDK 发送侧**只认 `reasoning_content` 一个出口**（见背景第 1 条）。`reasoning` / `reasoning_text` 仅在响应解析侧被识别。

第一阶段只保证 `reasoning_content` 可落实；另两个枚举值保留在 schema 中（表达意图），实现上**显式抛出可读错误**，不允许「配了不生效」的静默失败。

### D3：用「用户声明」作为新逻辑闸门，不动存量路径

新增行为仅在 `reasoningReplay.field === "reasoning_content"` 时启用；未声明模型走逐字节相同的现有代码。

先例对照：`runner.ts:390` 的 `projectRequestHistory` 首行 `if (resolved.providerKind !== "anthropic") return request;`——该早退为 Anthropic 的 thinking/signature 治理服务。本文**不改这个早退**，另设显式闸门，避免波及存量模型。

### D4：声明模型的落库与序列化豁免

开启闸门后：

1. **落库不丢空文本推理块**：`turn-model-step.ts` 的过滤对声明模型放宽——即文本为空时也保留该块（保持 assistant 消息的推理结构完整），依赖 `required` 决定是否补空占位。
2. **序列化不透支**：`transform.ts` 的 reasoning 分支对声明模型豁免空壳清理，保证 reasoning part 一定进入 `ModelMessage`。
3. **`required = true` 时补占位**：某条 assistant 消息完全没有推理内容时，仍输出 `reasoning_content: ""`（对齐 opencode 的 `requireReasoning` 语义，见 `openai-chat.ts` 字段决策链在 `reasoning.length === 0` 时仍返回 `"reasoning_content"`）。

### D5：让下一次偶发失败可取证 —— **已落地（2026-10-19）**

`MAX_ROLLOUT_FILES = 3` 使偶发失败无法复盘。已增加一项**诊断改进**（不改变行为语义）：每次**含 assistant 消息**的模型请求，向按天保留的主日志写一行 `info`，记录该请求的推理回放形态计数。

落点与形态：

- 新增 `apps/zcode-cli/packages/adapters/src/model/reasoning-replay-diagnostics.ts`，导出纯函数 `summarizeReasoningReplay(messages)` 与 `logReasoningReplayShape({ logger, messages, modelId, providerId })`。
- 在 `runner.ts` 的 `generateTextWithResolved` 与 `streamTextWithResolved` 中，于 `projectRequestHistory` 之后（即对**将要发送的**消息）调用。
- 日志事件名 `model.reasoning.replay.shape`，`info` 级，携带四个计数：`assistantMessages`、`reasoningBlocks`、`assistantMessagesWithoutReasoning`、`emptyReasoningBlocks`。

两条实现取舍：

1. **只在请求含 assistant 消息时记录**（首轮请求没有可丢失的历史推理，记 0/0 是噪声）。
2. 额外记录 `emptyReasoningBlocks`——对应 `hasAssistantReasoningContent` 会丢弃的形态，用于区分「本来就没有推理」与「推理被过滤掉」。

**关键前提**：主日志按日期保留（实测 `cli/log/zcode-*.jsonl` 可回溯多日），而 model-io 只留 3 个文件。这行计数因此是唯一能在失败后存活数天的证据。

是否同时提高 `MAX_ROLLOUT_FILES` 归为遗留项，见「未决问题」。

### D6：所有权与单一数据源

- `reasoningReplay` 唯一权威来源为 provider 配置的模型属性，经 `ModelPropertiesData` 下行；adapters/core 不建副本。
- 不按 provider id / baseURL / 模型名做任何嗅探。声明缺失即「不回放」，与现状一致。
- 复用既有 `providerOptions` 作为 reasoning part 透传载体，不新增平行字段。

## 行为

- `reasoningReplay` 为 `null`/缺省：行为与今天完全一致。**默认值。**
- `field = "reasoning_content"`、`required = false`：声明模型的空文本推理块不丢弃；上一轮有非空推理时正常回放。
- `field = "reasoning_content"`、`required = true`：完全无推理的 assistant 消息补空 `reasoning_content` 占位。
- `field` 为另两个值：请求构造阶段抛 `ModelReasoningReplayUnsupportedFieldError`，提示改用 `reasoning_content`。不静默降级。

## 失败语义

- schema 校验失败：按既有 `strict()` 行为报错，不进入运行时。
- 运行时字段不支持：抛错而非降级——静默降级正是本轮要消除的失败模式。
- 上游仍因其它原因拒绝：保持 `retryable=false`，不新增重试路径。

## 所有权与不变式

| 项                     | 所有者                                                         | 不变式                                       |
| ---------------------- | -------------------------------------------------------------- | -------------------------------------------- |
| `reasoningReplay` 声明 | provider 配置（shared schema infer）                           | 唯一权威；adapters/core 不复制、不改写       |
| 推理内容本体           | 会话历史（`ModelReasoningContentBlock`）                       | 落库存原样文本；剥离只在明确的过滤点发生     |
| 落库过滤               | `core/.../turn-model-step.ts` + `hasAssistantReasoningContent` | 声明模型不被丢空块；未声明模型路径逐字节不变 |
| 请求序列化             | `@ai-sdk/openai-compatible`                                    | `reasoning_content` 出口唯一，不写 SDK patch |

## 迁移边界

- `reasoningReplay` 为新增可选字段，缺省 `null`：存量配置零迁移、零行为变化。
- 旧 `providerSpecific.interleaved.field` / `reasoningContentField`（`bootstrap/tests/legacy-cli-personal-provider-config-importer.test.ts:247` 附近）**继续被忽略**——该组字段历史上从未被运行时消费（测试明文标注 "runtime 未消费"），本文不复活该路径。
- `0022-backfilled-session-reasoning` 迁移补的是 `reasoningLevel` 选项，**与 assistant 推理内容无关**，本任务不涉及。
- 不改 `packages/provider/src/config/*` 的站点规则匹配逻辑，不给 opencode-go 单独打补丁。

## 验收场景

1. **多轮回放（正向）**：声明模型跑两轮以上带工具调用的对话，断言第二轮起请求体 assistant 消息含上一轮 `reasoning_content` 且文本一致。
2. **空块不丢（正向）**：构造「推理块 text 为空、无 providerOptions」的流式落库，声明模型下该块保留；未声明模型下仍被丢弃（回归断言）。
3. **空占位（正向）**：`required = true` 且某条 assistant 消息无推理时，序列化结果含 `reasoning_content`（空串）。
4. **回归（负向）**：未声明 `reasoningReplay` 的既有模型，`turn-model-step` 落库与 `transform` 输出与改动前一致（对拍）。
5. **不支持字段（失败）**：`field = "reasoning"` 抛 `ModelReasoningReplayUnsupportedFieldError`。
6. **Anthropic 不受影响（回归）**：现有 thinking/signature 治理及其测试全绿。
7. **诊断可用（正向，已落地）**：含 assistant 消息的模型请求后，日志出现 `event: "model.reasoning.replay.shape"`，含 `assistantMessages` / `reasoningBlocks` / `assistantMessagesWithoutReasoning` / `emptyReasoningBlocks` 四个计数；首轮请求不产生该行。已由 `adapters/tests/reasoning-replay-diagnostics.test.ts` 与 `adapters/tests/runner.test.ts` 三条用例覆盖。

## 未决问题

1. **触发路径未坐实**：失败请求的轨迹已被轮转删除，无法比对。D4 的三条豁免基于「唯一已知剥离点」的代码走读，**不是实机坐实**。实现时应先补 D5 的诊断计数，重跑一次同类会话，用计数确认剥离是否真在发生；若计数正常，则 D4 的边界需按新证据重估。
2. **`cancelled-stream-persistence.ts` 未纳入本次走读**：该文件同样创建 reasoning 块（`core/src/runtime/methods/cancelled-stream-persistence.ts:26`），需在实现阶段确认它是否也需接入 D4。
3. **UI 入口**：`packages/ui/src` 当前没有 `openai-compatible` 的模型属性编辑表单，声明入口需新建或扩字段。细节待实现阶段按 `DESIGN.md` 补齐。
4. **`MAX_ROLLOUT_FILES` 是否提高**：提高可保留更多偶发证据，代价是磁盘占用。待 D5 落地后按实际收益再定。
5. **另两个字段名的落地时点**：`reasoning` / `reasoning_text` 在 schema 中存在但不生效，第二阶段是否通过 `providerOptions` 注入支持，或直接移出枚举，待第一阶段后定。
