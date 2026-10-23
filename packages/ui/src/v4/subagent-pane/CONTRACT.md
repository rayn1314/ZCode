# subagent-pane-ui

意图：子代理在左栏与会话面板两处的呈现与打开入口。左栏是两层——父条目**选中**时在下方展开
子区块，**未选中**时只显示计数角标（计数走 `SessionSummary.runningSubagentCount`，四个列表容器
都吃得到）；会话面板则从「只读」变可输入（见 `subagentChild` 形态）。

不变量：

- 数据两条来源各归其主：`running` 只来自父会话投影 `snapshot.subagents.running`，`ended` 明细来自
  既有分页查询、`endedTotal` 来自投影；本模块只合并排序，不新增第二真相源、不塞任务索引。
- 子区块里**运行中的不受 `limit` 限制**；同一 `childSessionId` 短暂同时出现在两处时**只保留运行中
  那行**（否则重复行 + 重复 React key）；「还有 N 个」= `endedTotal` − 已显示的已结束行数。
- 空数据**不渲染区块**（不留空态占位）；失败态自己成行且带重试；父条目未选中时不渲染区块。
- 形态是能力判定的唯一真相源：`readOnly` 也只是其中一列（`shape === "observe"`）。`observe` 保留
  goal 的**展示**（只有控制入口被关）、文件撤销是显式例外位；不要把 `goalPanel` 并进 `goalCommands`。
- 打开动作走壳层一处裁决的 context（`SubagentOpenProvider`），没有 provider 时子区块退化成文字，
  不给一个点不动的假入口。子区块内的按钮必须阻断冒泡，否则会连带再选一次父会话。
- 行身份空间（冷打开窗口态负数行号 ⇄ 权威全序）：识别与目标值计算是纯函数，**翻转那一帧必须按
  turn key 重锚定**，算不出就回「打开会话贴底」，绝不沿用旧空间的量做补偿。

交集与 hook 点：

- 左栏子树不在任何 V4 conversation provider 内，区块**自带一层 `V4PaneConversationProvider`**（按
  endpoint+workspaceKey 租用连接，复用主面板那条，不新增连接）；未就绪时该 provider 返回 `null`
  （未传 `unavailableFallback` 时），区块自然不渲染（fail-closed，与子代理目录面板一致）。
- 远端复制（desktop host 半边，`packages/desktop/src/host/remoteSubagentConfig.ts`）由本机权威在
  「写入后广播」与「远端连接就绪」两个时点推给 desktop-attached 远端 Host；standalone server 不推。
  ui 工程不解析 `@desktop/*`，因此这只是文字契约，见 `contract.ts`。

规格：`apps/zcode-cli/packages/core/spec/subagent-session-as-first-class.md`（左栏层级态 / 会话面板）、
`apps/zcode-cli/packages/bootstrap/spec/cold-open-window-first.md` §A/B（行身份空间）、
`apps/zcode-cli/packages/core/spec/subagent-settings-sync.md`（远端复制）。
