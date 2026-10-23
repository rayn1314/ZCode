// @vitest-environment jsdom
// 启动窗模型段的契约：清单状态 → 派生值的映射。
// 说明：本模块的派生值由 React hook 产出（`sessionModel` / `subagentModelCanonical` 都经过 ref 化的
// 选择器状态），因此这里用 renderHook 驱动真实 hook，只把清单订阅（`useModelSelectionView`）钉成
// 受控状态——被断言的映射逻辑与哨兵判定仍是真实现。纯函数那一半（哨兵值域）见本文件最后一个用例。
import { act, cleanup, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZCodeSavedWorkflowEntry } from "@zcode/shared";
import type { ModelSelectionState } from "@/hooks/useModelSelectionView.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { formatModelPickerValue, parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";
import { FOLLOW_SESSION_MODEL_VALUE, useSavedWorkflowLaunchModels } from "./contract.js";
import { savedWorkflowLaunchModule } from "./module.js";

const modelSelection = vi.hoisted(() => ({
  current: { status: "unavailable", reason: "missing-target" } as ModelSelectionState,
}));

// 只替换清单订阅这一层：测试要控制的是「清单不可用 / 就绪」，不是取数本身。
vi.mock("@/hooks/useModelSelectionView.js", () => ({
  useModelSelectionView: () => ({
    state: modelSelection.current,
    reload: () => {},
    refresh: () => Promise.reject(new Error("not used in contract test")),
  }),
}));

afterEach(() => {
  cleanup();
  modelSelection.current = { status: "unavailable", reason: "missing-target" };
  currentEntry = ENTRY;
});

const ENTRY: ZCodeSavedWorkflowEntry = {
  name: "release-check",
  description: "发布前检查",
  scope: "project",
  path: "/repo/.zcode/workflows/release-check.dwf.ts",
};
const PROJECT = { workspacePath: "/repo", label: "Beta" };

/** 换 entry 要真换引用：缺省回填是按 entry 身份触发的。 */
let currentEntry: ZCodeSavedWorkflowEntry | null = ENTRY;

function renderModels() {
  return renderHook(
    () =>
      useSavedWorkflowLaunchModels({
        entry: currentEntry,
        scope: "project",
        selectedTarget: undefined,
        modelCatalogTarget: PROJECT,
      }),
    {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(ZCodeIntlProvider, { initialLocale: "zh-CN", children }),
    },
  );
}

/** 清单就绪且工作区有 preferred：view 只带这两样，钩子其余派生（思考档）自然落空。 */
type ReadyCatalogView = Extract<ModelSelectionState, { status: "ready" }>["view"];

function readyView(preferred?: { providerId: string; modelId: string }): ReadyCatalogView {
  return {
    revision: 1,
    providers: [],
    ...(preferred ? { preferredSelection: preferred } : {}),
  };
}

describe("saved-workflow-launch contract", () => {
  it("declares its module manifest", () => {
    expect(savedWorkflowLaunchModule.id).toBe("saved-workflow-launch");
  });

  it("清单不可用 = fail-open：退成一句话，提交不带任何模型字段", () => {
    modelSelection.current = { status: "unavailable", reason: "missing-target" };
    const { result } = renderModels();

    expect(result.current.catalogFailed).toBe(true);
    expect(result.current.viewReady).toBe(false);
    // 会话模型：没定 → 不带 config.modelSelection，落 runtime 缺省（= 旧版行为）。
    expect(result.current.sessionValue).toBe(null);
    expect(result.current.sessionModel).toBeUndefined();
    // 子代理模型：默认跟随会话模型 → 不发字段。
    expect(result.current.subagentValue).toBe(FOLLOW_SESSION_MODEL_VALUE);
    expect(result.current.subagentModelCanonical).toBeUndefined();
    expect(result.current.groups).toEqual([]);
  });

  it("清单就绪：会话模型回填工作区 preferred，子代理默认跟随会话模型", () => {
    modelSelection.current = { status: "ready", view: readyView() };
    const noPreferred = renderModels();
    // 无 preferred 就保持 null：不猜一个默认模型。
    expect(noPreferred.result.current.sessionValue).toBe(null);
    expect(noPreferred.result.current.sessionModel).toBeUndefined();
    cleanup();

    modelSelection.current = {
      status: "ready",
      view: readyView({ providerId: "glm", modelId: "glm-4.6" }),
    };
    const { result } = renderModels();
    expect(result.current.sessionValue).toBe(encodeCustomModelValue("glm", "glm-4.6"));
    expect(result.current.sessionModel).toEqual({ providerId: "glm", modelId: "glm-4.6" });

    // 选一个具体模型：规范化成 providerId/modelId 作为 startSavedWorkflow.subagentModel。
    act(() => result.current.setSubagentValue(encodeCustomModelValue("glm", "glm-5")));
    expect(result.current.subagentModelCanonical).toBe("glm/glm-5");
    // 回到「跟随会话模型」：字段重新缺席。
    act(() => result.current.setSubagentValue(FOLLOW_SESSION_MODEL_VALUE));
    expect(result.current.subagentModelCanonical).toBeUndefined();
  });

  it("每次打开回到缺省：换 entry 后子代理模型跟随会话模型", () => {
    modelSelection.current = { status: "ready", view: readyView() };
    const { result, rerender } = renderModels();
    act(() => result.current.setSubagentValue(encodeCustomModelValue("glm", "glm-5")));
    expect(result.current.subagentModelCanonical).toBe("glm/glm-5");

    // 换一个 entry（= 再打开一次窗）：缺省回填按 entry 身份触发。
    currentEntry = { ...ENTRY, name: "release-check-2" };
    rerender();
    expect(result.current.subagentValue).toBe(FOLLOW_SESSION_MODEL_VALUE);
    expect(result.current.subagentModelCanonical).toBeUndefined();
  });

  it("哨兵不在模型值域内：不可能被选成模型，也不可能被当成模型解析", () => {
    // 真实模型值都来自 encodeCustomModelValue（带 custom: 前缀）；哨兵不在其中。
    expect(encodeCustomModelValue("workflow-launch", "follow-session")).not.toBe(
      FOLLOW_SESSION_MODEL_VALUE,
    );
    expect(FOLLOW_SESSION_MODEL_VALUE.startsWith("custom:")).toBe(false);
    // 解析器要求 providerId/modelId 分隔符：哨兵走进去必然抛错，而不是解析成一个假模型。
    expect(() => parseModelPickerValue(FOLLOW_SESSION_MODEL_VALUE)).toThrow();
    expect(formatModelPickerValue({ providerId: "glm", modelId: "glm-5" })).toBe("glm/glm-5");
  });
});
