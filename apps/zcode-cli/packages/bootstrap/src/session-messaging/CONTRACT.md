# 跨会话消息投递

意图：让一个会话能给另一个会话投递消息（含子代理），目标不可达时落进它的 mailbox 等下次自醒
drain；投递只有一条写路径（v4 命令面），不在 core 或本层另造 steerTurn 直调。

不变量：

- **拒绝不是降级**：链深超过上限（`SESSION_MESSAGE_MAX_HOP`）与「目标在 store 里不存在」都直接抛错，
  不写 mailbox、不唤醒（不存在的会话没有 drainer，落 mailbox 就是死信）。
- v4 幂等键只由消息稳定身份 `messageId` 派生（`sessionMessageV4CommandId` = `session-message:<id>`）；
  `requestId` 只服务跨进程路由与结果关联。同一条消息的 CLI 直投与 Host 转投必须共用这一个键。
- 投递档恒为 `guide`（不按发送时刻的活动回合切换）：`startNow` 会抢占并 abort 目标刚起的轮，
  空闲目标的唤醒由 guide 路由开新轮完成。
- 落地方式如实报告：`steered` / `woken` / `stored`；mailbox 落盘失败必须抛出，不假装成功。
- 入站防环链只有人类输入才清空；`session-message-port` 提交的无链输入一律 keep，
  空 drain 也不例外（没有来消息不等于人来插话）。
- 来源身份由发送方填充、接收方只读；子代理是附属身份，不得伪造正式会话身份。

与其它模块的交集（hook 点）：

- core 侧入站链的唯一写入点：`core/src/runtime/methods/session-message-chain.ts`（工具侧只经
  `SessionMessageChainReader` 读实时链，不自行推导链深）。
- input 准入与三档投递的判据：`packages/shared/src/zcode-protocol-v4/input-role-policy.ts`
  的 `INPUT_COMMAND_ROLE_POLICY` / `resolveInputCommandAdmission`（`deniedFor` 是唯一拒绝轴）。
- mailbox 落盘：CLI `adapters` 的 Node mailbox 与 Host services 的
  `packages/services/src/session/sessionMailboxStore.ts` 共用同一套文件名规则
  （`@zcode/shared` 的 `session-mailbox`，其根解析归 data-roots）。
- 信封渲染：`packages/ui/src/lib/sessionMessageEnvelope.ts` 只剥信封不改写，回写一律用原样 `raw`。

相关 spec：`apps/zcode-cli/packages/core/spec/session-message-audit-fixes.md`、
`apps/zcode-cli/packages/core/spec/subagent-session-messaging.md`、
`packages/ui/spec/session-message-envelope-rendering.md`。
