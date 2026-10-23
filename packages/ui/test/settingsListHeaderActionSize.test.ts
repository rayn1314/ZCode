import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// Commands/Hooks/Subagents/Memory 的头部纯图标按钮已收进共享组件
// SettingsResourceHeaderActions（icon-md）；仍自带图标的页面沿用 icon-lg。
// 上游把插件商店页顶栏动作改成 secondary（刷新 / 市场源），插件列表页不再自带头部按钮。
const selfRenderedIconFiles = {
  "McpSettingsSection.tsx": { count: 1, variant: "outline" },
  "PluginStorePage.tsx": { count: 2, variant: "secondary" },
  "SkillsSection.tsx": { count: 1, variant: "outline" },
} as const;

const delegatingSections = [
  "CommandsSection.tsx",
  "HooksSection.tsx",
  "MemorySettingsViewer.tsx",
  "SubagentsSection.tsx",
] as const;

describe("settings list header actions", () => {
  it("纯图标按钮沿用各自 variant，共享头部动作用 icon-md", async () => {
    for (const [fileName, expected] of Object.entries(selfRenderedIconFiles)) {
      const source = await readFile(
        new URL(`../src/settings/${fileName}`, import.meta.url),
        "utf8",
      );
      const pattern = new RegExp(`variant="${expected.variant}"\\s+size="icon-lg"`, "g");
      expect(source.match(pattern), fileName).toHaveLength(expected.count);
    }

    const shared = await readFile(
      new URL("../src/settings/SettingsResourceHeaderActions.tsx", import.meta.url),
      "utf8",
    );
    expect(shared.match(/variant="outline"\s+size="icon-md"/g)).toHaveLength(2);
  });

  it.each(delegatingSections)("%s 头部图标按钮由共享组件渲染", async (fileName) => {
    const source = await readFile(new URL(`../src/settings/${fileName}`, import.meta.url), "utf8");
    expect(source).toContain("<SettingsResourceHeaderActions");
    expect(source).not.toMatch(/size="icon-lg"/);
  });

  it("插件列表右上角操作按钮使用统一的 8px 间距", async () => {
    const source = await readFile(
      new URL("../src/settings/PluginStorePage.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain('className="flex flex-wrap items-center gap-2"');
  });
});
