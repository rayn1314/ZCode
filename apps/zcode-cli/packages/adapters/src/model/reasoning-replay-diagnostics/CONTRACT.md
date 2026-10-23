# 模型推理回放诊断

意图：模型请求被上游以「thinking 模式必须回传 reasoning_content」拒绝时，模型 I/O 轨迹只保留
3 个文件、很快被轮转覆盖，事后无法复盘。本模块在每次请求后把「推理内容是什么形态」压成四个计数
写进按天保留的主日志，让下一次偶发失败不需要完整轨迹也能判断命中哪条剥离路径。

不变量：

- 只读诊断：不改消息、不改请求体、不写业务数据；计数口径与落库过滤
  （`core` 的 `hasAssistantReasoningContent`：文本为空且无 `providerOptions` 的推理块会被丢弃）一致，
  因此 `emptyReasoningBlocks` 才能区分「本来就没有推理」与「推理被过滤掉」。
- 请求不含 assistant 消息时不记录（首轮没有可丢失的历史推理），所以「有一行诊断日志」本身
  就说明这是一次多轮请求。
- 一次调用最多写一行 `info`（`event: "model.reasoning.replay.shape"`），不等待持久化；写失败不影响请求。

与其它模块的交集在**请求构造完成后的那一个点**处理：`adapters` 的 runner 在
`projectRequestHistory` 之后、真正发请求之前调用，因此统计到的是「将要发送的」历史形态，
而不是落库历史。相关 spec：`apps/zcode-cli/packages/core/spec/model-reasoning-replay-declaration.md`（D5）。

回归：`apps/zcode-cli/packages/adapters/tests/reasoning-replay-diagnostics.test.ts`（纯计数口径）、
`tests/reasoning-replay-diagnostics/contract.test.ts`（事件名、首轮不记录、多轮只记一行）。
