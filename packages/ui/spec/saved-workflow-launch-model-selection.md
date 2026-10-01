# 工作流手动启动的模型选择前置

涉及包：`packages/shared`（协议）、`apps/zcode-cli/packages/bootstrap`（命令 handler）、
`apps/zcode-cli/packages/core`（启动实现）、`packages/ui`（启动窗与启动器，主责包）。

## 背景与问题

自动化页面（中枢）手动「运行」一个已保存的工作流时，GUI 直接启动：
建一个空会话（不带 config，落 runtime 缺省模型）→ 发 `startSavedWorkflow`（只带
name/scope/args）→ 跳转到新会话。模型选择在启动前完全不可见也不可控：

- 会话模型：新会话落在 runtime 缺省模型上，连发起会话的 composer 选择都不继承；
- 子代理模型：run 未指定 `subagentModel` 时子代理继承会话模型，用户无从前置干预；
- 唯一的 GUI 选模入口在 run 详情侧板的「配置」弹层，只在**启动后**可用。

## 设计决策

1. **选择器放在启动窗**（`SavedWorkflowLaunchDialog`），不在确认窗：中枢启动是纯 GUI
   发起，不存在「批准的输入 ≠ 模型提交的输入」的一致性问题；模型发起的
   `CreateWorkflow` 确认窗加选择器需要权限协议支持「带修订的批准」，另立任务。
2. **无实参项目档一律弹窗**（用户决策）：此前无实参项目档点「运行」跳过弹窗直接启动；
   模型选择前置后，启动窗是每次手动启动的唯一入口，一致性优先于省一次点击。
3. **会话模型走既有协议面**：`createSession.config.modelSelection` 早已存在
   （v4 命令层），只是启动器从不带。本轮只是把它接上，协议零改动。
4. **子代理模型走协议增量**：`startSavedWorkflow` payload 新增可选 `subagentModel`
   （规范串 `providerId/modelId[$level]`）。语义与 `amendWorkflowRunSettings.subagentModel`
   同形，但 start 没有「回到默认」的三态，不收 `null`。
5. **校验 fail-closed**：core 在启动的零副作用窗口用模型目录端口解析
   `subagentModel`，解不出来（含目录缺席）即在**任何持久化之前**拒绝
   （`model_unavailable`），绝不静默回落会话模型——静默回落会让用户选的模型无声失效。
   原因码与 `workflowRunSettingsRejectionReasonSchema.model_unavailable` 同名同义。
6. **缺省 = 现状行为**：两个选择器都可以不产生任何字段（清单不可用、无 preferred），
   此时启动路径与旧版逐字节相同。旧 GUI 不发新键；新 GUI 发的 `subagentModel` 被
   旧 CLI 的非 strict zod 静默剥离（fail-open，与 `offPeakToolEnabled` 同例）。

## 行为

### 启动窗（SavedWorkflowLaunchDialog）

布局（自上而下）：标题区（图标 + 名字 + 作用域徽标 + 说明）→「运行于」（仅全局档）→
**会话模型选择器** → **子代理模型选择器** → 实参表 →「将立即在 X 的新会话中运行」提示 →
行内错误区（如有）→ 取消 / 运行。

- **会话模型**：`useModelSelectionView`（项目档 = 所属项目坐标 `modelCatalogTarget`；
  全局档 = 窗内「运行于」选中的目标，随切换刷新；窗关着 = null 不订阅）。
  默认值 = 工作区 `preferredSelection`（与 composer 新会话同源）；选定即补注册表默认
  思考档（`completeNewModelSelection`）。提交时作为 `createSession.config.modelSelection`。
- **子代理模型**：同一份清单；菜单首项「跟随会话模型」（哨兵
  `workflow-launch:follow-session`，值域与真实模型不相交），为缺省选中项。选定具体模型
  即补默认思考档，提交时规范化为 `providerId/modelId[$level]` 串随
  `startSavedWorkflow.subagentModel` 下发。
- **状态**：清单加载中两个选择器禁用；清单不可用（unavailable/error）→ 两个字段退成
  一句提示（`workflows.hub.launch.modelUnavailable`），提交照常可用（不带模型字段）；
  启动 pending 期间一并禁用。
- 测试 id：`workflow-launch-session-model` / `workflow-launch-subagent-model` /
  `workflow-launch-model-unavailable`（`test-ids-workflow.ts`）。

### 事件顺序

```
启动窗「运行」
  → createSession { workspaceId, config?{ modelSelection } }     ← 会话模型在此生效
  → startSavedWorkflow { name, scope, args?, subagentModel? }
      → core.startSavedWorkflowRun：
          (0) 忙碌检查
          (1) 解析 saved 工作流 + 实参校验
          (1b) subagentModel 经 modelCatalogPort.resolveModelReference 解析
              ——失败回 model_unavailable（零副作用：无 run、无消息、无事件、无任务）
          (2) 编译诊断检查
          (4) port.submit({ …, subagentModel?: ModelSelection })
  → accepted：导航到新会话；rejected：deleteSession 回收空会话 + 行内错误
```

子代理模型生效优先级（`bootstrap/src/app/workflow-actor-model.ts`，既有不变式）：
run 显式 `subagentModel` > journal pin > 父会话当前模型。主代理恒在会话模型上。

### 全局组 / 项目组

- 项目组：`handleRun` 一律 `setLaunchEntry(entry)`（删除原无实参直接启动分支及其
  toast 错误路径——错误统一走窗内错误区）；`modelCatalogTarget={project}`。
- 全局组：本来就一律弹窗；onSubmit 透传 models。

## 所有权与不变式

- 模型清单的订阅所有者是启动窗自身（`useModelSelectionView`），只在窗开着时活跃；
  调用组只递坐标（`AutomationWorkspaceOption`），不传清单数据。
- `SavedWorkflowLaunchModels`（`useSavedWorkflowLauncher.ts`）是启动窗 → 启动器的唯一
  模型载荷形状：`sessionModel?: ModelSelection`、`subagentModel?: string`。
- 启动器（`useSavedWorkflowLauncher`）是 GUI 侧唯一的 createSession /
  startSavedWorkflow 发起点；「失败在会话存在之前」不变式不变（start 被拒即回收空会话）。
- core 的 `startSavedWorkflowRun` 仍是 `port.submit` 的第二个调用方，与
  `CreateWorkflow` 工具路径同构；模型解析复用 `resolveModelReference`（工具路径同一函数）。

## 失败语义

| 失败                                                                | 表现                                                                                                                                                |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 模型清单不可用                                                      | 启动窗字段退成一句提示；提交不带模型字段，行为 = 旧版                                                                                               |
| `subagentModel` 解析失败（目录缺席 / 名字不存在 / 禁用 / 档位未知） | ACK reasonCode `fault.command.savedWorkflowStartRejected.model_unavailable`，解析诊断（候选清单等）随 `ack.message` 进行内错误区；空会话被 GUI 回收 |
| `createSession.config.modelSelection` 应用失败                      | 既有 v4 语义：降级 warn、不连坐建会话，会话落 runtime 缺省模型（跨目标切换选中的模型在新目录不存在时可能触发，可接受）                              |
| 其它启动失败                                                        | 既有词表（invalid_name / not_found / invalid_args / compile_failed / session_busy / start_failed）不变                                              |

## 迁移边界

- 旧 GUI + 新 CLI：不发新键，行为不变。
- 新 GUI + 旧 CLI：`subagentModel` 被旧 schema 静默剥离（fail-open），run 落会话模型，
  不报错——接受；会话模型 `config.modelSelection` 是既有协议字段，旧 CLI 本就支持。
- `model_unavailable` 新增进 `savedWorkflowStartRejectionReasonSchema`：词表是增量枚举，
  旧 GUI 对未知 reasonCode 走 `generic` 兜底（`mapLaunchError` 既有行为）。

## 验收路径（手动）

1. 带实参的项目档 →「运行」→ 弹窗含两个选择器，会话模型预选工作区默认 → 改选另一模型 →
   运行 → 新会话跑在所选模型上（会话配置可见；run 侧板「跟随会话模型」指向它）。
2. 子代理选具体模型 → 运行 → run 详情侧板显示「Subagents run on …」该模型。
3. 子代理保持「跟随会话模型」→ 运行 → 侧板无「Subagents run on …」行（继承会话模型）。
4. 无实参的项目档 →「运行」→ 弹窗（不再直接启动）。
5. 全局档 → 切换「运行于」目标 → 两个选择器的清单跟随目标刷新。
6. 断开目标连接 → 清单不可用提示出现，仍可点「运行」（落缺省模型）。
7. 手改一个失效的子代理模型串发给新 CLI（开发场景）→ 行内错误区出现
   「子代理模型不可用」+ 候选清单；无 run、无会话残留。
