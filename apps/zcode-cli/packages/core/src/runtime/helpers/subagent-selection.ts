import { createCoreError, CoreErrorType, type ModelSelection } from "../deps.js";
import { cloneModelSelection } from "../model-selection.js";
import type { EffectiveModelSelectionResult } from "@zcode/shared/model-selection";

const SUBAGENT_SELECTION_MESSAGES = {
  "selection-missing": "No model selected / 未选择模型",
  "account-connection-unavailable": "Account connection unavailable / 当前账号连接不可用",
  "provider-not-found": "Provider unavailable / 供应商不存在或不可用",
  "model-not-found": "Model unavailable / 模型不存在或不可用",
  "reasoning-level-missing": "No reasoning level selected / 未选择思考档位",
  "reasoning-level-not-supported": "Reasoning level unsupported / 不支持所选思考档位",
} satisfies Record<NonNullable<EffectiveModelSelectionResult["selectionIssue"]>, string>;

/**
 * 子代理选型的解析顺序（**顺序是契约的一部分**，见 spec `core/spec/subagent-session-messaging.md`
 * D6）：`override(turn) ≥ 调用级 > profile > 父模型`。
 *
 * - `overrideSelection`：Core Server / 闲时轮对前台 child 的最高优先级选型，已有执行归属，直接采用。
 * - `callSelection`：`Agent` 的调用级 `model`（`resolveInput` 已解析成规范形）。它是**这一发
 *   spawn 的一次性请求**，只活在这里；与显式 profile 同样要过 `resolveSelection`（目录里的规范
 *   形还需要映射到当前账号的 provider），失败同样不回退。
 * - 被调用级压在下层的 profile 与父模型只是它本来要替换的缺省，因此不参与解析。
 *
 * `hasConcreteModel` 表示「这次 spawn 有显式选定的模型」（profile 或调用级）。调用方据此跳过
 * 「继承父模型实例」那条捷径：一个显式选定必须真的去构造那个模型。
 *
 * 显式 profile 是待解析意图；继承与内部 override 已有执行归属，不重新对应账号。
 */
export function resolveSubagentSelection(input: {
  profileSelection?: ModelSelection | null;
  parentSelection?: ModelSelection | null;
  overrideSelection?: ModelSelection;
  callSelection?: ModelSelection;
  resolveSelection?: (selection: ModelSelection) => EffectiveModelSelectionResult;
}): { hasConcreteModel: boolean; selection: ModelSelection } {
  const explicit = input.profileSelection;
  const call = input.callSelection;
  const result: EffectiveModelSelectionResult = input.overrideSelection
    ? { effectiveSelection: input.overrideSelection }
    : call
      ? input.resolveSelection
        ? input.resolveSelection(cloneModelSelection(call))
        : { effectiveSelection: call }
      : explicit
        ? input.resolveSelection
          ? input.resolveSelection(cloneModelSelection(explicit))
          : { effectiveSelection: explicit }
        : { effectiveSelection: input.parentSelection ?? null };
  if (!result.effectiveSelection || result.selectionIssue) {
    const reason = result.selectionIssue ?? "selection-missing";
    const requested = input.overrideSelection ?? call ?? explicit ?? input.parentSelection;
    const identity = requested ? `; selection=${requested.providerId}/${requested.modelId}` : "";
    // 解析失败不能落回父模型，否则会悄悄改变用户显式指定的子任务模型。
    // 公共错误投影不读取结构化字段（只有 selectionIssue 时消费方看不到）；后台也只保留 message。
    // 因此同时给既有 reason 和消息补上原因，两个消费路径都能定位，不增加专用错误协议。
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      `Cannot start subagent: ${SUBAGENT_SELECTION_MESSAGES[reason]} [reason=${reason}${identity}]`,
      {
        recoverable: true,
        context: {
          selectionIssue: reason,
          reason,
          ...(result.effectiveSelection
            ? {
                providerId: result.effectiveSelection.providerId,
                modelId: result.effectiveSelection.modelId,
              }
            : {}),
        },
      },
    );
  }
  return {
    hasConcreteModel: call != null || explicit != null,
    selection: cloneModelSelection(result.effectiveSelection),
  };
}
