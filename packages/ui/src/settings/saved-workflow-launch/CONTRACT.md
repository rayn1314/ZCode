# saved-workflow-launch

意图：从自动化页面（中枢）手动「运行」一个已保存工作流时，**在启动前**选定新会话的模型与
子代理模型。此前模型选择完全不可见：会话模型从不带 `config.modelSelection`、子代理模型无从前置
干预（唯一入口在 run 详情侧板，启动后才可用）。

不变量：

- **缺省 = 旧版行为**：两个字段都可以不产生任何键（清单不可用、无 preferred、子代理跟随会话模型），
  此时启动路径与改动前逐字节相同。清单不可用是 fail-open（还能点「运行」，落缺省模型），
  与「子代理模型解析失败必须 fail-closed 拒绝」是两回事——后者在 core 的零副作用窗口判定。
- 会话模型默认值 = 工作区 `preferredSelection`（与 composer 新会话同源）；选定即补注册表默认思考档
  （`completeNewModelSelection`），提交为 `createSession.config.modelSelection`。
- 子代理模型默认 = 「跟随会话模型」，哨兵 `FOLLOW_SESSION_MODEL_VALUE` 落在模型值域之外（不带
  `custom:` 前缀、也没有 `providerId/modelId` 分隔符），不可能与真实模型相撞；选了具体模型才规范化成
  `providerId/modelId[$level]` 随 `startSavedWorkflow.subagentModel` 下发。
- 每次打开（entry 变化）回到缺省：不留上一次的模型选择。
- 清单订阅的唯一所有者是本模块，且**只在窗开着时活跃**；调用组只递坐标，不传清单数据。

交集与 hook 点：

- 启动编排（建空会话 → startSavedWorkflow → 失败回收空会话）在启动器 `useSavedWorkflowLauncher`，
  不在本模块；本模块只交「两个派生值 + 渲染入口」，提交时按 `SavedWorkflowLaunchModels` 组装。
- 形态/权限、实参表、窗口布局都属启动窗自身的其他职责；本模块只负责模型段。

规格：`packages/ui/spec/saved-workflow-launch-model-selection.md`。
