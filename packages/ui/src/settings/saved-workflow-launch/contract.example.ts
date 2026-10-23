/**
 * saved-workflow-launch 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 *
 * 三段就是 `SavedWorkflowLaunchDialog` 实际做的事：①订阅清单拿派生值并渲染字段；②提交时把派生值
 * 组装成启动器的模型载荷。（启动窗自己持有 `models`：渲染交给子组件，提交读最后两项。）
 */
import { createElement } from "react";
import type { ZCodeSavedWorkflowEntry } from "@zcode/shared";
import type { AutomationWorkspaceOption } from "@/settings/automationWorkspaceOptions.js";
import {
  SavedWorkflowLaunchModelFields,
  useSavedWorkflowLaunchModels,
  type SavedWorkflowLaunchModels,
  type SavedWorkflowLaunchModelsState,
} from "./contract.js";

const entry: ZCodeSavedWorkflowEntry = {
  name: "release-check",
  description: "发布前检查",
  scope: "project",
  path: "/repo/.zcode/workflows/release-check.dwf.ts",
};
/** 清单作用域：项目档传所属项目坐标；全局档改传窗内选中的「运行于」目标。 */
const project: AutomationWorkspaceOption = { workspacePath: "/repo", label: "Beta" };

/** ① 订阅 + 派生 + 渲染：窗关着（entry 为 null）时不订阅清单，不留一份白付的订阅。 */
export function SavedWorkflowLaunchModelFieldsExample({ pending }: { pending: boolean }) {
  const models = useSavedWorkflowLaunchModels({
    entry,
    scope: "project",
    selectedTarget: undefined,
    modelCatalogTarget: project,
  });
  return createElement(SavedWorkflowLaunchModelFields, { models, pending });
}

/** ② 提交：缺席字段不带键——`sessionModel` 缺席 = 落 runtime 缺省；`subagentModel` 缺席 = 跟随会话模型。 */
export function buildLaunchModelsPayload(
  models: SavedWorkflowLaunchModelsState,
): SavedWorkflowLaunchModels {
  return {
    ...(models.sessionModel === undefined ? {} : { sessionModel: models.sessionModel }),
    ...(models.subagentModelCanonical === undefined
      ? {}
      : { subagentModel: models.subagentModelCanonical }),
  };
}
