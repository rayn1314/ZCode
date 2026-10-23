/**
 * saved-workflow-launch 对外契约：调用方要想正确调用就必须知道的一切都写在这里；其余对外不可见。
 *
 * 模块意图：已保存工作流的**手动启动窗里的模型选择段**——两个选择器（会话模型 / 子代理模型）的
 * 清单订阅、派生值、字段渲染，以及「启动窗 → 启动器」的模型载荷形状。
 * 「点运行 = 建空会话 + startSavedWorkflow」这段启动编排属于启动器（`useSavedWorkflowLauncher`），
 * 不在本模块；本模块只交两样东西：要提交的两个值 + 渲染入口。
 *
 * 规格：packages/ui/spec/saved-workflow-launch-model-selection.md。
 */
import type { SavedWorkflowLaunchModelsState } from "@/settings/saved-workflows/SavedWorkflowLaunchModelFields.js";

export {
  FOLLOW_SESSION_MODEL_VALUE,
  SavedWorkflowLaunchModelFields,
  useSavedWorkflowLaunchModels,
} from "@/settings/saved-workflows/SavedWorkflowLaunchModelFields.js";
export type {
  SavedWorkflowLaunchModelsScope,
  SavedWorkflowLaunchModelsState,
} from "@/settings/saved-workflows/SavedWorkflowLaunchModelFields.js";
export type { SavedWorkflowLaunchModels } from "@/settings/saved-workflows/useSavedWorkflowLauncher.js";

/**
 * `useSavedWorkflowLaunchModels(scope)`：清单订阅 + 两个选择器的派生值。
 *
 * 前置：`entry` 是当前要启动的条目，**为 null（窗关着）时一律不订阅清单**——弹窗常驻挂载，
 * 关着时不能白付订阅。清单作用域：项目档 = 所属项目坐标 `modelCatalogTarget`；全局档 = 窗内选中的
 * 「运行于」目标（随切换刷新）。
 * 后置：`entry` 每次变化都回到缺省——会话模型等清单就绪后按工作区 `preferredSelection` 回填
 * （与 composer 新会话同源），子代理模型回到「跟随会话模型」。派生值语义：
 * - `sessionValue === null` / `sessionModel === undefined`：尚未定（清单没就绪或无 preferred）→
 *   提交不带 `config.modelSelection`，落 runtime 缺省；选定后补注册表默认思考档。
 * - `subagentValue === FOLLOW_SESSION_MODEL_VALUE` → `subagentModelCanonical === undefined`
 *   （不发字段，子代理继承会话模型）；选了具体模型则规范化为 `providerId/modelId[$level]`。
 * - `viewReady` / `catalogFailed`：清单状态。`catalogFailed`（unavailable / error）时两个字段退成
 *   一句话提示，**提交照常可用且不带模型字段**（fail-open 到既有缺省，行为 = 旧版）。
 * 幂等：纯派生，同输入同输出；不发命令、不写盘、不等持久化（命令由启动器发）。
 */

/**
 * `SavedWorkflowLaunchModelFields({ models, pending })` 的 props 契约（实现在
 * `SavedWorkflowLaunchModelFields.tsx`）：
 * - `models`：`useSavedWorkflowLaunchModels` 的返回值，组件只渲染、不自己取数；
 * - `pending`：启动进行中 → 两个选择器一并禁用（不让用户在提交途中换模型）。
 * 后置：`catalogFailed` 时整段退成一句话（不渲染空选择器）；`viewReady === false` 时选择器禁用
 * （没得可选）。
 */
export interface SavedWorkflowLaunchModelFieldsProps {
  models: SavedWorkflowLaunchModelsState;
  pending: boolean;
}

/**
 * 提交载荷映射（`SavedWorkflowLaunchModels`，类型由启动器导出、这里不重复声明）：
 * - `sessionModel` ← `state.sessionModel`，落进 `createSession.config.modelSelection`；
 * - `subagentModel` ← `state.subagentModelCanonical`，随 `startSavedWorkflow.subagentModel` 下发，
 *   在引擎侧排在模型优先级最高位（run 显式 > journal pin > 父会话当前模型）。
 * 两个字段都可缺席：缺席 = 不带该键，维持既有缺省语义。
 *
 * **哨兵不能与真实模型值相撞**：`FOLLOW_SESSION_MODEL_VALUE`（`workflow-launch:follow-session`）
 * 不在 `encodeCustomModelValue` 的值域内（真实值一律带 `custom:` 前缀），也不含
 * `providerId/modelId` 的分隔符——既不可能被选成模型，也不可能被当成模型解析（见 contract.test.ts）。
 */
