import { describe, expect, it } from "vitest";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";
import {
  appendLocalCustomizeTemplate,
  resolveOffPeakTemplateText,
} from "@/settings/automationTemplateCatalog.js";

describe("Automations terminology", () => {
  it("localizes the sidebar automations entry and settings title", () => {
    // 上游以 project-sidebar/ProjectSidebarNavigation 取代了本 fork 合并后的「任务」顶层入口：
    // 侧栏重新提供独立的自动化入口（workspace.openScheduledSettings），文案与设置页标题一致。
    expect(enUS["workspace.openScheduledSettings"]).toBe("Automations");
    expect(zhCN["workspace.openScheduledSettings"]).toBe("自动化");
    expect(enUS["settings.automations.title"]).toBe("Automations");
    expect(zhCN["settings.automations.title"]).toBe("自动化");
  });

  it("keeps 定时任务 for the scheduled-task subtype", () => {
    expect(zhCN["automations.list.title"]).toBe("定时任务");
    expect(zhCN["offPeak.tabs.scheduled"]).toBe("定时任务");
    expect(zhCN["taskList.cronTaskLabel"]).toBe("定时任务");
  });

  it("keeps the empty-state description focused on task creation modes", () => {
    expect(enUS["automations.description"]).toBe(
      "Schedule recurring tasks or queue background work that runs during idle time.",
    );
    expect(zhCN["automations.description"]).toBe("创建定时任务，或排队在闲时算力空闲时后台执行。");
  });

  it("keeps idle-time permissions on the main conversation vocabulary", () => {
    const modeValues = ["build", "edit", "plan", "yolo"] as const;

    expect(modeValues.map((value) => zhCN[`mode.label.glm.${value}`])).toEqual([
      "变更前确认",
      "自动编辑",
      "计划模式",
      "完全访问",
    ]);
    expect(modeValues.map((value) => enUS[`mode.label.glm.${value}`])).toEqual([
      "Ask before changes",
      "Edit automatically",
      "Plan mode",
      "Full access",
    ]);
    for (const value of modeValues) {
      expect(zhCN[`offPeak.mode.${value}`]).toBeUndefined();
      expect(enUS[`offPeak.mode.${value}`]).toBeUndefined();
    }
  });

  it("keeps the local Customize fallback copy for Client Scenes failures", () => {
    const customize = appendLocalCustomizeTemplate([])[0]!;
    const format =
      (messages: Record<string, string>) =>
      ({ id }: { id: string }) =>
        messages[id] ?? id;

    expect(resolveOffPeakTemplateText(customize, "title", "zh-CN", format(zhCN))).toBe("自定义");
    expect(resolveOffPeakTemplateText(customize, "title", "en-US", format(enUS))).toBe("Customize");
    expect(
      resolveOffPeakTemplateText(customize, "description", "zh-CN", format(zhCN)),
    ).toBeTruthy();
    expect(
      resolveOffPeakTemplateText(customize, "description", "en-US", format(enUS)),
    ).toBeTruthy();
  });

  it("keeps imminent next-run copy grammatical across locales", () => {
    const englishNextRun = enUS["automations.nextRun"].replace(
      "{when}",
      enUS["automations.time.soon"],
    );
    const chineseNextRun = zhCN["automations.nextRun"].replace(
      "{when}",
      zhCN["automations.time.soon"],
    );

    expect(englishNextRun).toBe("Next run soon");
    expect(chineseNextRun).toBe("下次运行 1 分钟内");
  });
});
