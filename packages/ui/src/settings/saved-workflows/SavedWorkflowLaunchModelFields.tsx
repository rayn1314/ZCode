// ============================================================
// 启动窗的「模型选择段」
// ============================================================
// 从 SavedWorkflowLaunchDialog.tsx 拆出（max-lines 门）：模型清单订阅、两个选择器的派生值
// 与字段渲染是同一段职责，整段搬来这里。启动窗只拿两样东西——提交用的两个值
// （sessionModel / subagentModelCanonical）和渲染入口（SavedWorkflowLaunchModelFields）。

import { useCallback, useEffect, useMemo, useState } from "react";
import { completeNewModelSelection } from "@zcode/provider";
import {
  TID_WORKFLOW_LAUNCH_MODEL_UNAVAILABLE,
  TID_WORKFLOW_LAUNCH_SESSION_MODEL,
  TID_WORKFLOW_LAUNCH_SUBAGENT_MODEL,
  ZCODE_AGENT_PROVIDER,
  type ModelSelection,
  type ZCodeSavedWorkflowEntry,
} from "@zcode/shared";
import { useModelSelectionView } from "@/hooks/useModelSelectionView.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  ModelConfigSelect,
  type ModelSelectGroup,
  type ModelSelectGroupItem,
} from "@/ModelConfigSelect.js";
import { buildRegistryModelSelectGroups } from "@/lib/modelSelectionGroups.js";
import { formatModelPickerValue, parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";
import {
  resolveAutomationPreferredModelValue,
  resolveAutomationModelTriggerLabel,
} from "@/settings/automationAgentConfigOptions.js";
import type { AutomationWorkspaceOption } from "@/settings/automationWorkspaceOptions.js";

/**
 * 「子代理模型」菜单里「跟随会话模型」那一项的值：落在 encodeCustomModelValue 的值域之外，
 * 不会与真实模型相撞（与运行设置弹层的 SESSION_MODEL_VALUE 同一模式）。
 */
export const FOLLOW_SESSION_MODEL_VALUE = "workflow-launch:follow-session";

/** 模型菜单不禁用任何项（启动窗没有可锁定语义）。模块级常量：ModelConfigSelect 是 memo 组件。 */
const NEVER_LOCKED = () => false;

/** 选择器触发器样式：与运行设置弹层的模型字段同一条（h-7 全宽输入框形）。 */
const MODEL_TRIGGER_CLASS_NAME =
  "h-7 w-full min-w-0 justify-between rounded-md border border-input-border bg-input px-2 text-foreground hover:border-input-border-hover hover:bg-input focus-visible:border-input-border-focused focus-visible:bg-input-focused";

/** 模型清单的作用域参数：项目档 = 所属项目；全局档 = 窗内选中的「运行于」目标（可为 undefined）。 */
export interface SavedWorkflowLaunchModelsScope {
  entry: ZCodeSavedWorkflowEntry | null;
  scope: "project" | "global";
  selectedTarget: AutomationWorkspaceOption | undefined;
  modelCatalogTarget: AutomationWorkspaceOption | null | undefined;
}

/** 启动窗的模型段状态：渲染交给 {@link SavedWorkflowLaunchModelFields}，提交读最后两项。 */
export interface SavedWorkflowLaunchModelsState {
  /** 清单读不出来（连接断开等）：字段退成一句话，提交不带模型字段（= 既有缺省行为）。 */
  catalogFailed: boolean;
  viewReady: boolean;
  groups: readonly ModelSelectGroup[];
  sessionValue: string | null;
  subagentValue: string;
  sessionTriggerLabel: string;
  subagentTriggerLabel: string;
  followSessionItems: readonly ModelSelectGroupItem[];
  /** createSession.config.modelSelection；undefined = 不带 config，落 runtime 缺省。 */
  sessionModel: ModelSelection | undefined;
  /** startSavedWorkflow.subagentModel 规范串；undefined = 子代理跟随会话模型。 */
  subagentModelCanonical: string | undefined;
  setSessionValue: (value: string) => void;
  setSubagentValue: (value: string) => void;
}

export function useSavedWorkflowLaunchModels({
  entry,
  scope,
  selectedTarget,
  modelCatalogTarget,
}: SavedWorkflowLaunchModelsScope): SavedWorkflowLaunchModelsState {
  const { intl } = useZCodeIntl();
  const format = useCallback((id: string) => intl.formatMessage({ id }), [intl]);
  // 会话模型：null = 尚未定（清单没就绪 / 无 preferred）→ 提交不带 config，落 runtime 缺省。
  const [sessionValue, setSessionValue] = useState<string | null>(null);
  // 子代理模型：哨兵 = 跟随会话模型（不发字段）。
  const [subagentValue, setSubagentValue] = useState<string>(FOLLOW_SESSION_MODEL_VALUE);

  // 每次打开回到缺省：会话模型等清单就绪后由 preferredSelection 回填；子代理跟随会话模型。
  useEffect(() => {
    setSessionValue(null);
    setSubagentValue(FOLLOW_SESSION_MODEL_VALUE);
  }, [entry]);

  // 模型清单的作用域：全局档 = 窗内选中的「运行于」目标（随切换刷新）；项目档 = 所属项目。
  // 窗关着（entry === null）时为 null，useModelSelectionView 的订阅随之挂起——弹窗常驻挂载，
  // 关着时不能白付订阅。
  const modelTarget = scope === "global" ? selectedTarget : (modelCatalogTarget ?? null);
  const modelCoord = entry === null ? null : modelTarget;
  const modelRead = useModelSelectionView(
    modelCoord?.workspacePath ?? null,
    modelCoord?.remoteSessionId ?? null,
    modelCoord?.workspaceIdentity ?? null,
    modelCoord?.remoteTarget,
  );
  const view = modelRead.state.status === "ready" ? modelRead.state.view : null;
  const groups = useMemo(
    () =>
      view === null
        ? []
        : buildRegistryModelSelectGroups(ZCODE_AGENT_PROVIDER, view, {
            apiKeyLabel: format("settings.modelProvider.apiKey"),
            apiKeyBadgeLabel: format("settings.modelProvider.connectionMode.apiKeyBadge"),
            codingPlanLabel: format("settings.modelProvider.connectionMode.codingPlan"),
            codingPlanBadgeLabel: format("settings.modelProvider.connectionMode.codingPlanBadge"),
            startPlanLabel: format("settings.modelProvider.connectionMode.startPlan"),
            startPlanBadgeLabel: format("settings.modelProvider.connectionMode.startPlanBadge"),
            teamPlanBadgeLabel: format("settings.modelProvider.connectionMode.teamPlanBadge"),
            teamPlanFallbackLabel: format("settings.modelProvider.connectionMode.teamPlan"),
          }),
    [format, view],
  );
  const catalogFailed =
    modelRead.state.status === "unavailable" || modelRead.state.status === "error";

  // 清单就绪且用户没动过时，把会话模型钉到工作区的 preferredSelection（与 composer 新会话同源）。
  // 一直为 null（无 preferred）就保持 null：提交时不带 config，落到 runtime 缺省。
  useEffect(() => {
    if (view === null || sessionValue !== null) return;
    setSessionValue(resolveAutomationPreferredModelValue(view));
  }, [sessionValue, view]);

  // 会话模型选择 → createSession.config.modelSelection；补注册表默认思考档（composer 同一规则）。
  const sessionModel = useMemo<ModelSelection | undefined>(() => {
    if (sessionValue === null) return undefined;
    const picked = parseModelPickerValue(sessionValue);
    const level =
      view === null ? undefined : completeNewModelSelection(view, picked)?.options?.reasoningLevel;
    return {
      providerId: picked.providerId,
      modelId: picked.modelId,
      ...(level === undefined ? {} : { options: { reasoningLevel: level } }),
    };
  }, [sessionValue, view]);

  // 子代理模型选择 → 规范串 `providerId/modelId[$level]`（startSavedWorkflow.subagentModel）。
  const subagentModelCanonical = useMemo<string | undefined>(() => {
    if (subagentValue === FOLLOW_SESSION_MODEL_VALUE) return undefined;
    const picked = parseModelPickerValue(subagentValue);
    const level =
      view === null ? undefined : completeNewModelSelection(view, picked)?.options?.reasoningLevel;
    return formatModelPickerValue({
      providerId: picked.providerId,
      modelId: picked.modelId,
      ...(level === undefined ? {} : { options: { reasoningLevel: level } }),
    });
  }, [subagentValue, view]);

  const sessionTriggerLabel = useMemo(
    () =>
      resolveAutomationModelTriggerLabel({
        modelGroups: groups,
        modelSelectionView: view,
        modelValue: sessionValue ?? "",
        fallbackLabel: format("workflows.hub.launch.sessionModel"),
      }),
    [format, groups, sessionValue, view],
  );
  // 「跟随会话模型」项：badge 说语义，name 说此刻跟的是哪个模型。
  const followSessionItem = useMemo<ModelSelectGroupItem>(
    () => ({
      key: "workflow-launch:follow-session",
      value: FOLLOW_SESSION_MODEL_VALUE,
      name: sessionTriggerLabel,
      badgeLabel: format("workflows.hub.launch.subagentModel.followSession"),
    }),
    [format, sessionTriggerLabel],
  );
  // ModelConfigSelect 是 memo 组件：内联数组每次渲染都是新引用，会让它的 memo 形同虚设。
  const followSessionItems = useMemo(() => [followSessionItem], [followSessionItem]);
  const subagentTriggerLabel = useMemo(
    () =>
      subagentValue === FOLLOW_SESSION_MODEL_VALUE
        ? format("workflows.hub.launch.subagentModel.followSession")
        : resolveAutomationModelTriggerLabel({
            modelGroups: groups,
            modelSelectionView: view,
            modelValue: subagentValue,
            fallbackLabel: format("workflows.hub.launch.subagentModel"),
          }),
    [format, groups, subagentValue, view],
  );

  return {
    catalogFailed,
    viewReady: view !== null,
    groups,
    sessionValue,
    subagentValue,
    sessionTriggerLabel,
    subagentTriggerLabel,
    followSessionItems,
    sessionModel,
    subagentModelCanonical,
    setSessionValue,
    setSubagentValue,
  };
}

/** 两个字段（或清单不可用的一句话）。清单没就绪时选择器禁用（没得可选）。 */
export function SavedWorkflowLaunchModelFields({
  models,
  pending,
}: {
  models: SavedWorkflowLaunchModelsState;
  pending: boolean;
}) {
  const { intl } = useZCodeIntl();
  const format = (id: string) => intl.formatMessage({ id });
  const disabled = pending || !models.viewReady;
  const triggerClassName = MODEL_TRIGGER_CLASS_NAME;

  if (models.catalogFailed) {
    return (
      <p
        className="text-ui-sm text-foreground-subtle"
        data-testid={TID_WORKFLOW_LAUNCH_MODEL_UNAVAILABLE}
      >
        {format("workflows.hub.launch.modelUnavailable")}
      </p>
    );
  }
  return (
    <>
      {/* 会话模型：新会话将跑在它上面。 */}
      <div className="flex flex-col gap-1.5" data-testid={TID_WORKFLOW_LAUNCH_SESSION_MODEL}>
        <span className="text-ui-base font-medium text-foreground">
          {format("workflows.hub.launch.sessionModel")}
        </span>
        <span className="inline-flex min-w-0" data-model-current-value={models.sessionValue ?? ""}>
          <ModelConfigSelect
            modelGroups={models.groups}
            normalizedValue={models.sessionValue ?? ""}
            triggerLabel={models.sessionTriggerLabel}
            showManageModelsAction={false}
            lockReasonMessage=""
            isItemLocked={NEVER_LOCKED}
            onValueChange={models.setSessionValue}
            contentSide="bottom"
            contentAlign="start"
            focusSelectorOnClose={null}
            labelVisibilityClassName="inline-flex min-w-0"
            triggerClassName={triggerClassName}
            triggerLabelClassName="inline-flex min-w-0 flex-1 truncate text-left"
            triggerTestId="workflow-launch-session-model-trigger"
            disabled={disabled}
          />
        </span>
      </div>
      {/* 子代理模型：默认「跟随会话模型」＝ 不发字段；选了具体模型随 startSavedWorkflow 下发。 */}
      <div className="flex flex-col gap-1.5" data-testid={TID_WORKFLOW_LAUNCH_SUBAGENT_MODEL}>
        <span className="text-ui-base font-medium text-foreground">
          {format("workflows.hub.launch.subagentModel")}
        </span>
        <span className="inline-flex min-w-0" data-model-current-value={models.subagentValue}>
          <ModelConfigSelect
            modelGroups={models.groups}
            normalizedValue={models.subagentValue}
            triggerLabel={models.subagentTriggerLabel}
            showManageModelsAction={false}
            lockReasonMessage=""
            isItemLocked={NEVER_LOCKED}
            onValueChange={models.setSubagentValue}
            leadingItems={models.followSessionItems}
            contentSide="bottom"
            contentAlign="start"
            focusSelectorOnClose={null}
            labelVisibilityClassName="inline-flex min-w-0"
            triggerClassName={triggerClassName}
            triggerLabelClassName="inline-flex min-w-0 flex-1 truncate text-left"
            triggerTestId="workflow-launch-subagent-model-trigger"
            disabled={disabled}
          />
        </span>
      </div>
    </>
  );
}
