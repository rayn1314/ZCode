# 辅助对话（selection side chat）的身份提示词

- 主责包：`apps/zcode-cli/packages/core`
- 涉及其它包：无（纯 core 上下文构建改动）

## 背景与问题

辅助对话（UI「在辅助对话中提问」）走普通会话 fork 路径（`taskType === "selection_side_chat"`），
与主 Agent 使用完全相同的 system prompt，其中包含「自主行动、可改就改」的行为边界
（`Context Management` / `Dynamic Behavior`）。约束它「不要接父任务」的唯一信号是一条 user
角色的合成边界消息（`session-fork.ts` 的 `SELECTION_SIDE_CHAT_BOUNDARY`），权重远低于 system 层。

实测现象（用户反馈）：

1. 辅助对话认不清自己是辅助对话，表现为行为与主 Agent 无异；
2. 经常自主接着父任务的活跃工作继续做；
3. 忽略用户消息末尾引用的选段——引用被序列化为 `# userselect:` 代码块 + JSON
   （UI `conversationSelectionReference.ts`），模型从未被告知这个块的含义。

## 设计决策

在 system 层补一段辅助对话专属身份段，同时在 fork 边界消息里点明引用块：

1. **新增 ContextSection source** `selection_side_chat_identity`，携带稳定、system 注入的身份段：
   - 明确自己是父任务开出的辅助对话，不是主 Agent；
   - 父对话历史只是参考，不得自动续做、重跑工具或接手编辑；
   - 只在侧边对话里回答新问题，工作区改动仅在用户明确要求时进行；
   - 用户消息末尾的 `# userselect:` 块是被引用的选段，回答必须围绕它。
2. **按 `taskType === "selection_side_chat"` 注入**：在 `createContextBuilderFromSnapshot` 里对
   辅助对话调用 `addSection`，其它 taskType 不产生任何额外段。
3. **强化 fork 边界消息**：`SELECTION_SIDE_CHAT_BOUNDARY` 增加一句对 `# userselect:` 块的解释。
   该消息只影响新建的辅助对话；已存在的辅助对话通过 system 身份段（冷恢复同样会重建上下文）生效。

## 行为

- 辅助对话的首轮及后续轮次，system 消息中包含「辅助对话身份段」；普通会话 / 子代理 / 工作流子代理
  的 system 消息不包含该段。
- 新建辅助对话的继承历史末尾，边界消息包含对 `# userselect:` 引用块的解释。
- 冷恢复的辅助对话（`createRecord` 重建）同样获得身份段：`runtimeConfig.taskType` 持久化为
  `selection_side_chat`，`createContextBuilderFromSnapshot` 在 resume 时重新执行注入。

## 所有权与不变式

- 身份段的唯一写入点是 `addSelectionSideChatIdentityIfNeeded`（`context/sections/selection-side-chat.ts`），
  判定条件固定为 `taskType === "selection_side_chat"`；不得在别处复制这段文本。
- `ContextSource` 新增值 `selection_side_chat_identity` 只用于该段；现有按 source 的过滤逻辑
  （`source !== "cli_prefix"` / `source !== "skills"`）不受影响。
- 身份段不进入持久化消息历史，每次上下文构建时由 runtime 重新生成。

## 失败语义

- `addSection` 是纯内存操作，不引入 IO；上下文构建失败路径与现有 system 段一致。
- 若 `taskType` 缺失（旧记录），辅助对话身份段不注入，行为回退到本次改动前——这是可接受的降级，
  不抛错。

## 迁移边界

- 已存在的辅助对话在下次 resume / context refresh 时自动获得身份段，无需数据迁移。
- UI 引用序列化格式（`# userselect:` + JSON）保持不变，解析与历史重建无需改动。