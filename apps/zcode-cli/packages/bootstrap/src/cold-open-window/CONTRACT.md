# 冷打开：窗口优先 + 后台补全

意图：打开未常驻的历史会话时，先把「尾部窗口 + 窗口态行号空间」的首帧发出去，后台再补权威投影，
把「等全量读」的延迟从首帧路径上移走。本模块只负责**行号换算**与**首帧 config 种子**两件事。

不变量：

- 窗口态行号恒为负数、权威全序行号恒为正数；两代行号不得混用，客户端只凭首帧首行符号识别窗口态。
- 窗口态是纯预览：`rows.firstRowId` = 实际下发窗口的首行（客户端 `hasOlderRows` 恒 false），
  窗口行的 `actions` 一律清空——窗口态行号是临时代数，命令目标只能在补全后按全序行号解析。
- 补全是整份原子替换，没有中间态；窗口态→权威态之间到达的 online delta 不丢。
- 首帧 config 只取持久化事实（模型选型 entry + transcript 末条 assistant 的 mode），拿不到就留空，
  不伪造 runtime 能力（`thoughtLevels` 恒不填充）。
- 行号只由「消息全局序号 + 消息内行序」决定，与窗口边界无关；因此跨帧稳定。

与其它模块的交集（hook 点）：

- 什么时候进窗口态、打帧边界现算 `firstRowId`、何时整份替换：`v4-gateway`（`ensureColdOpenPublisher`）。
- host 侧取数钩子：`v4-bridge` 的 `readMessageWindow` / `synthesizeTranscriptEvents` /
  `getPersistedSessionConfigSeed`；store 侧的 `messageWindow` 读法在 `adapters`。
- 行身份空间翻转的客户端处理（重锚定）归 `packages/ui`，不在本模块。

相关 spec：`apps/zcode-cli/packages/bootstrap/spec/cold-open-window-first.md`。
