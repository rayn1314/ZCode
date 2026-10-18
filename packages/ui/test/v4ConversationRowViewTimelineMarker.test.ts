// @vitest-environment jsdom

import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";
import type { TimelineMarkerRow } from "@zcode/shared/zcode-protocol-v4";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { formatCompactTokenNumber } from "@/lib/tokenNumberFormat.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { resetCompactionSummaryCache } from "@/hooks/useCompactionSummary.js";
import { ConversationRowView } from "@/v4/ConversationRowView.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";

const modelSelectionMock = vi.hoisted(() => ({ view: null as ModelSelectionView | null }));

const context: ConversationRowRenderContext = {
  codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
  sessionId: "session-1",
  theme: "system",
  workspacePath: "/workspace",
};

function currentContext(): ConversationRowRenderContext {
  return { ...context, modelSelectionView: modelSelectionMock.view };
}

function renderMarker(row: TimelineMarkerRow, locale: "en-US" | "zh-CN" = "zh-CN"): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(ConversationRowView, { context: currentContext(), row }),
    ),
  );
}

afterEach(() => {
  modelSelectionMock.view = null;
});

function replaceProviders(providers: readonly { providerId: string; label: string }[]): void {
  modelSelectionMock.view = {
    revision: 1,
    providers: providers.map((provider) => ({
      providerId: provider.providerId,
      providerName: provider.label,
      config: {},
      models: [],
    })),
  } satisfies ModelSelectionView;
}

describe("ConversationRowView timeline marker contract", () => {
  it("exposes compact type, status, and origin without using localized text as authority", () => {
    const html = renderMarker({
      rowId: 12,
      turnId: "turn-1",
      createdAt: 1_700_000_000_000,
      createdAtSeq: 1,
      kind: "timelineMarker",
      sourceCommandId: "command-compact-1",
      marker: {
        type: "compact",
        status: "success",
        origin: "manual",
        operationId: "compact-1",
      },
    });

    expect(html).toContain('data-row-kind="timelineMarker"');
    expect(html).toContain('data-marker-type="compact"');
    expect(html).toContain('data-status="success"');
    expect(html).toContain('data-origin="manual"');
    expect(html).toContain('data-source-command-id="command-compact-1"');
  });

  it("不同供应商的同名模型使用供应商名称展示完整切换身份", () => {
    replaceProviders([
      { providerId: "primary-provider", label: "Primary Coding Plan" },
      { providerId: "alternate-provider", label: "Alternate API" },
    ]);

    const html = renderMarker({
      rowId: 13,
      turnId: "turn-2",
      createdAt: 1_700_000_001_000,
      createdAtSeq: 2,
      kind: "timelineMarker",
      marker: {
        type: "modelChange",
        fromProvider: "primary-provider",
        fromModel: "glm-5.2",
        toProvider: "alternate-provider",
        toModel: "glm-5.2",
        toThought: "high",
      },
    });

    expect(html).toContain("模型已切换 Primary Coding Plan/glm-5.2 → Alternate API/glm-5.2");
    expect(html).toContain("lucide-arrow-right-left");
  });

  it("source 缺失的初始模型事实渲染为正在使用实际模型", () => {
    replaceProviders([{ providerId: "child-provider", label: "Child Provider" }]);

    const row: TimelineMarkerRow = {
      rowId: 17,
      turnId: "turn-child-1",
      createdAt: 1_700_000_005_000,
      createdAtSeq: 6,
      kind: "timelineMarker",
      marker: {
        type: "modelChange",
        toProvider: "child-provider",
        toModel: "child-model",
        toThought: "high",
      },
    };
    const html = renderMarker(row);
    const englishHtml = renderMarker(row, "en-US");

    expect(html).toContain("正在使用 Child Provider/child-model");
    expect(html).not.toContain("正在使用 Child Provider/child-model 模型");
    expect(html).not.toContain("模型已切换");
    expect(html).not.toContain("lucide-arrow-right-left");
    expect(englishHtml).toContain("Using Child Provider/child-model");
    expect(englishHtml).not.toContain("Using Child Provider/child-model model");
  });

  it("账号套餐模型显示套餐类型，自定义供应商保留名称", () => {
    replaceProviders([
      {
        providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
        label: "Z.ai - Coding Plan",
      },
      {
        providerId: "custom:provider-b",
        label: "Provider B",
      },
    ]);

    const html = renderMarker({
      rowId: 16,
      turnId: "turn-5",
      createdAt: 1_700_000_004_000,
      createdAtSeq: 5,
      kind: "timelineMarker",
      marker: {
        type: "modelChange",
        fromProvider: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
        fromModel: "GLM-5.2",
        toProvider: "custom:provider-b",
        toModel: "model-b-4.5",
        toThought: "high",
      },
    });

    expect(html).toContain("模型已切换 GLM-5.2(个人套餐) → Provider B/model-b-4.5");
  });

  it.each([
    [BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan, "个人套餐", "Individual Plan"],
    [BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan, "体验套餐", "Start Plan"],
    [BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan, "团队套餐", "Team Plan"],
    [BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan, "个人套餐", "Individual Plan"],
    [BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan, "体验套餐", "Start Plan"],
    [BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan, "团队套餐", "Team Plan"],
  ])("目录缺失时仍按记录的 %s 展示套餐，支持中英文和首次使用", (providerId, zh, en) => {
    const row: TimelineMarkerRow = {
      rowId: 18,
      turnId: "turn-plan",
      createdAt: 1_700_000_006_000,
      createdAtSeq: 7,
      kind: "timelineMarker",
      marker: {
        type: "modelChange",
        fromProvider: providerId,
        fromModel: "GLM-5.3",
        toProvider: BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
        toModel: "GLM-5.3",
      },
    };
    expect(renderMarker(row)).toContain(`模型已切换 GLM-5.3(${zh}) → GLM-5.3(体验套餐)`);
    expect(renderMarker(row, "en-US")).toContain(`GLM-5.3(${en}) → GLM-5.3(Start Plan)`);
    row.marker = { type: "modelChange", toProvider: providerId, toModel: "GLM-5.3" };
    expect(renderMarker(row)).toContain(`正在使用 GLM-5.3(${zh})`);
  });

  it("供应商配置缺失时回落 provider ID 以保留同名模型身份", () => {
    const html = renderMarker({
      rowId: 14,
      turnId: "turn-3",
      createdAt: 1_700_000_002_000,
      createdAtSeq: 3,
      kind: "timelineMarker",
      marker: {
        type: "modelChange",
        fromProvider: "removed-provider",
        fromModel: "glm-5.2",
        toProvider: "current-provider",
        toModel: "glm-5.2",
        toThought: "high",
      },
    });

    expect(html).toContain("模型已切换 removed-provider/glm-5.2 → current-provider/glm-5.2");
  });

  it("供应商目录稍后水合时原地刷新已渲染 marker 名称", () => {
    const row: TimelineMarkerRow = {
      rowId: 15,
      turnId: "turn-4",
      createdAt: 1_700_000_003_000,
      createdAtSeq: 4,
      kind: "timelineMarker",
      marker: {
        type: "modelChange",
        fromProvider: "primary-provider",
        fromModel: "glm-5.2",
        toProvider: "alternate-provider",
        toModel: "glm-5.2",
        toThought: "high",
      },
    };
    const view = render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ConversationRowView, { context: currentContext(), row }),
      ),
    );
    expect(view.container.textContent).toContain(
      "模型已切换 primary-provider/glm-5.2 → alternate-provider/glm-5.2",
    );

    act(() => {
      replaceProviders([
        { providerId: "primary-provider", label: "Primary Coding Plan" },
        { providerId: "alternate-provider", label: "Alternate API" },
      ]);
      view.rerender(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(ConversationRowView, { context: currentContext(), row: { ...row } }),
        ),
      );
    });

    expect(view.container.textContent).toContain(
      "模型已切换 Primary Coding Plan/glm-5.2 → Alternate API/glm-5.2",
    );
    view.unmount();
  });
});

describe("ConversationRowView 压缩摘要块契约", () => {
  // 契约（spec: packages/ui/spec/compact-summary-block.md 的 D5 / §3 / §5）：
  // 只有「终态成功 + summaryRef + 读端可用」三件齐备才出现展开入口；任何一项缺席都
  // 退回升级前的纯分隔线；展开才请求，失败给重试。
  const SUMMARY_BODY = "Summary:\n1. 目标\n2. 关键决策";
  const readCompactionSummary = vi.fn(async () => ({ summary: SUMMARY_BODY }));

  function compactRow(
    marker: Partial<Extract<TimelineMarkerRow["marker"], { type: "compact" }>> = {},
  ): TimelineMarkerRow {
    return {
      rowId: 21,
      turnId: "turn-compact",
      createdAt: 1_700_000_010_000,
      createdAtSeq: 10,
      kind: "timelineMarker",
      sourceCommandId: "command-compact-9",
      marker: {
        type: "compact",
        status: "success",
        origin: "manual",
        summaryRef: "msg_summary_1",
        tokensBefore: 128_000,
        tokensAfter: 21_000,
        ...marker,
      },
    };
  }

  function renderCompact(
    row: TimelineMarkerRow,
    overrides: Partial<ConversationRowRenderContext> = {},
  ) {
    return render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ConversationRowView, {
          context: { ...currentContext(), readCompactionSummary, ...overrides },
          row,
        }),
      ),
    );
  }

  function renderCompactMarkup(
    row: TimelineMarkerRow,
    overrides: Partial<ConversationRowRenderContext> = {},
  ): string {
    return renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ConversationRowView, {
          context: { ...currentContext(), readCompactionSummary, ...overrides },
          row,
        }),
      ),
    );
  }

  beforeEach(() => {
    readCompactionSummary.mockClear();
    resetCompactionSummaryCache();
  });

  it("终态成功且有 summaryRef 时块头可展开，默认折叠且显示 token 变化", () => {
    const html = renderCompactMarkup(compactRow());

    expect(html).toContain('data-marker-type="compact"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("展开上下文摘要");
    expect(html).toContain(
      `${formatCompactTokenNumber("zh-CN", 128_000)} → ${formatCompactTokenNumber("zh-CN", 21_000)}`,
    );
    // 默认折叠：块头在、正文不在，且不请求。
    expect(html).not.toContain("data-compaction-summary-body");
    expect(readCompactionSummary).not.toHaveBeenCalled();
  });

  it.each([
    ["running", { status: "running" as const }],
    ["failed", { status: "failed" as const }],
    ["cancelled", { status: "cancelled" as const }],
    ["noop", { status: "noop" as const }],
    ["summaryRef 缺失", { summaryRef: undefined }],
  ])("status=%s 时保持纯分隔线，不给展开入口", (_label, marker) => {
    const html = renderMarker(compactRow(marker));

    expect(html).toContain('data-marker-type="compact"');
    expect(html).not.toContain("aria-expanded");
    expect(html).not.toContain("展开上下文摘要");
    expect(html).not.toContain("data-compaction-summary-body");
  });

  it("读端不可用（旧宿主注入不到读函数）时同样降级为纯分隔线", () => {
    const view = renderCompact(compactRow(), { readCompactionSummary: undefined });

    expect(view.container.innerHTML).not.toContain("aria-expanded");
    expect(view.container.innerHTML).not.toContain("展开上下文摘要");
    view.unmount();
  });

  it("两个 token 计数缺任一项时不显示 token 变化，但展开入口仍在", () => {
    const html = renderCompactMarkup(compactRow({ tokensAfter: undefined }));

    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("→");
  });

  it("展开后才请求并显示落库的摘要正文", async () => {
    const view = renderCompact(compactRow());
    expect(readCompactionSummary).not.toHaveBeenCalled();

    fireEvent.click(view.container.querySelector('button[data-marker-type="compact"]')!);

    await waitFor(() => {
      expect(view.container.querySelector("[data-compaction-summary-body]")?.textContent).toContain(
        SUMMARY_BODY,
      );
    });
    expect(readCompactionSummary).toHaveBeenCalledWith({
      sessionId: "session-1",
      messageId: "msg_summary_1",
    });
    expect(
      view.container
        .querySelector('button[data-marker-type="compact"]')
        ?.getAttribute("aria-expanded"),
    ).toBe("true");
    view.unmount();
  });

  it("读取失败显示失败文案与重试入口，重试后恢复且不阻断会话", async () => {
    readCompactionSummary
      .mockRejectedValueOnce(new Error("fault.compactionSummary.notFound: msg_summary_1"))
      .mockResolvedValueOnce({ summary: SUMMARY_BODY });
    const view = renderCompact(compactRow());

    fireEvent.click(view.container.querySelector('button[data-marker-type="compact"]')!);
    await waitFor(() => {
      expect(view.container.querySelector("[data-compaction-summary-body]")?.textContent).toContain(
        "上下文摘要加载失败",
      );
    });

    fireEvent.click(
      Array.from(view.container.querySelectorAll("button")).find(
        (button) => button.textContent === "重试",
      )!,
    );
    await waitFor(() => {
      expect(view.container.querySelector("[data-compaction-summary-body]")?.textContent).toContain(
        SUMMARY_BODY,
      );
    });
    expect(readCompactionSummary).toHaveBeenCalledTimes(2);
    view.unmount();
  });
});
