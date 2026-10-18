# 压缩前后 token 数的口径（Compact Token Count Basis）

主责包：`apps/zcode-cli/packages/core`。

涉及的其他包：

- `apps/zcode-cli/packages/bootstrap`：`product-projection` 把 `CompactCompleted` 载荷映射成 timeline marker（摘要块）并同时改写 `usage.contextWindow.usedTokens`（容量面板）。
- `packages/ui`：摘要块 `before → after` 的展示（`packages/ui/spec/compact-summary-block.md`）。

---

## 1. 背景与问题

压缩链路上有**三套互不相同的 token 计数口径**，其中两套会并排展示给用户，长期造成"压缩前后到底省了多少"无法对账：

1. **容量面板的「已用」**：`getModelUsageContextTokens` = 最近一次模型调用回报的 `inputTokens + outputTokens`（真实值）。
2. **自动压缩的触发判定**：`shouldAutoCompact` 的 `tokenCount` = `buildProviderUsageTokenOverride` 给出的**混合值**——真实最后一轮 provider 锚点 + 本地估算的增量。
3. **摘要块的 `before` / `after`**：压缩前是 `preCompactTokenCount`，压缩后是 `truePostCompactTokenCount`，两者都是**纯字符估算**（`estimateMessageTokens`，`ceil(字符数 / 3)`）。

第 3 项与其他两项不同源，实测偏差可以到 ±50%：

- 纯估算只数 provider 的**消息体**，数不到工具 schema 等请求固定开销 → 系统性偏低。本机实测：某次自动压缩估算出 31,827，压缩完成 119 毫秒后第一次真实请求回报 `inputTokens = 52,670`，只有实测的 59%。
- `÷3` 对英文/代码偏高、对中文明显偏低（`.length / 3` ≈ 0.33 token/汉字），偏差方向随内容构成翻转。本机实测同一会话两次压缩分别偏高 47% 与偏低 12%。

更刺眼的是**压缩成功瞬间**：`product-projection` 会把 `usage.contextWindow.usedTokens` 直接写成 `tokensAfter`（同一个估算值），于是摘要块的 `after` 与容量面板会短暂"分毫不差"——它们是同一个变量渲染两次。等下一次真实请求回来，面板被 provider 数字覆盖，两者又开始不一致。用户看到的是一个先吻合、随后跳变的数字。

## 2. 设计决策

### D1. `before` 改用"真实锚点 + 估算增量"，与触发判定同源

摘要块的 `before`（即 `preCompactTokenCount`）不再用纯估算，改为复用压缩门禁已在用的 `buildProviderUsageTokenOverride` 口径：

```
before = provider 锚点（最后一轮 assistant 的 inputTokens(+outputTokens)） + 本地估算的增量（锚点之后的消息）
```

这样做的收益是**口径收口**：用户看到的"压了多少"和系统据以决定"要不要压"从此是同一把尺子。主体（真实锚点）是 provider 数出来的，只有锚点之后新增的那几条消息是估算的——而那部分在语义上确实无从实测。

### D2. `after` 维持纯估算，本轮不改

`after`（`truePostCompactTokenCount`）**动不得**，两条理由：

1. 它同时是**决策输入**：`willRetriggerNextTurn = truePostCompactTokenCount >= autoCompactThreshold` 决定"压完会不会立刻又压"。换算口径就是换阈值行为。
2. 它没有免费的实测替代品。压缩请求自己回报的用量（`postCompactTokenCount`）的输入是**压缩前的完整上下文 + 摘要指令**，本机实测 15.6万~31.4万，比 `pre` 还大——它衡量"这次压缩花了多少"，不是"压完剩多少"。投影层优先取 `truePostCompactTokenCount`、把 provider 值只当兜底，这个取舍是对的。

因此本轮结果里摘要块会呈现"before 是实测口径、after 是估算口径"的混合；这是有意的分步，`after` 的改造（估算态展示或异步回填）另立任务。

### D3. 容量面板的压缩后写入点不动

`product-projection` 在 compact success 时写 `usedTokens = tokensAfter` 的行为保持不变（D2 的直接后果）。它带来的"面板先吻合后跳变"是已知代价，与 `after` 口径一并处理。

## 3. 行为与不变式

### 3.1 公式

```
投影 = buildProviderRequestMessages(activeEntries, { applyCacheControl: false, useMidConversationSystem })
before = estimateCurrentModelInputTokens(投影.messages, 投影.sourceEntries)
       = 锚点.contextUsageTokens（或 inputTokens） + estimateMessageTokens(锚点之后的 messages)
```

锚点由 `findLatestCommittedAssistantUsage` 在**当前投影的** `sourceEntries` 上反向扫描得到，要求该 assistant 条目的持久化 `tokens.input > 0`。

### 3.2 硬不变式：无锚点逐位退化为纯估算

`estimateCurrentModelInputTokens` 的兜底分支是 `estimateMessageTokens(同一份 projection 的 messages)`，与 `estimateRuntimeEntryTokens` 逐位相同。因此**没有可用锚点时，`before` 与改造前完全一致**。

无锚点的场景（都退回纯估算，属预期）：

- 新会话的第一次压缩（历史里还没有带 usage 的 assistant）。
- **刚压过、还没跑过模型**：compact 会把 preserved tail 里 assistant 的 provider usage 清零（`invalidateRuntimeTokenUsage`，理由是该 usage 属于已被替换的旧前缀），清零后 `persistedTokenUsageBaseline` 返回 `undefined`，扫描不会命中旧前缀的假锚点。这条已有测试守着（`runtime-compact.test.ts` "estimates the assistant preserved by reactive compact locally"）。
- 锚点条目已被 rewind / 分支切除出当前投影。

最后两条是这个口径**不会算出比真实上下文更大的值**的根据：无锚点即退化，不存在"拿旧前缀的大数字当锚点"的路径。

### 3.3 副作用面（非决策）

`preCompactTokenCount` 的消费方，全部随口径一起变化：

| 消费方 | 影响 |
| --- | --- |
| timeline 载荷（started / completed / skipped） | 摘要块展示值、落库 `compactBoundary` |
| `PreCompact` / `PostCompact` hook 输入 | hook 拿到更准的数 |
| `createCompactPromptTooLongError` 的错误 context | 诊断信息 |

**没有任何压缩决策读取 `preCompactTokenCount`**（阈值走 `shouldAutoCompact` 的 `tokenOverride`，重触发走 `truePostCompactTokenCount`）。因此这是展示 + 遥测口径变更，不是行为判据变更。

## 4. 失败语义

- 锚点存在但 `messageIndex >= messages.length`：视为无锚点，退化纯估算（`buildProviderUsageTokenOverride` 既有守卫）。
- 锚点 usage 只有 `total`：`persistedInputWindowTokens` 会减去 output 反推输入侧，行为不变。
- 估算本身抛错（tool call input 循环引用等）：既有 `stringifyToolCallInputForTokenEstimate` 降级为空对象 JSON，不新增兜底分支。

## 5. 迁移边界

- **历史落库数值不追溯。** 已存在的 `compactBoundary.preCompactTokenCount` 保持旧值（纯估算），冷恢复读到的也是旧值。新旧记录并存，不做回填。
- 无协议 / schema 变更：字段名与类型不变，只是数值来源变了。
- 不引入新的估算函数、不调整 `ESTIMATED_TOKEN_CHAR_DIVISOR`（÷3 的准确性问题是另一件事，且会改阈值行为）。

## 6. 验收场景

1. 最后一条 assistant 带真实 usage、其后无新消息：`before` = 该 assistant 的 `inputTokens + outputTokens`（与容量面板同值）。
2. 最后一条 assistant 带真实 usage、其后有新消息：`before` = 锚点 + 新消息的本地估算。
3. 无可用锚点（首压 / 刚压过 / 锚点被切除）：`before` 与 `estimateRuntimeEntryTokens` 的结果逐位相同。
4. preserved tail 的 assistant usage 已被清零时，`before` 不采用旧前缀的数值。

场景 1–4 由 `apps/zcode-cli/packages/core/tests/runtime-compact.test.ts` 的 `estimatePreCompactTokenCount` 用例覆盖。
