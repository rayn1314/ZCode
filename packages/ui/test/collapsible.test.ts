import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../src/components/ui/collapsible.js";

describe("Collapsible", () => {
  it("keeps the closed animation end frame while content is still mounted", () => {
    const html = renderToStaticMarkup(
      createElement(
        Collapsible,
        { defaultOpen: false },
        createElement(CollapsibleTrigger, null, "Toggle"),
        createElement(CollapsibleContent, { forceMount: true }, "Details"),
      ),
    );

    expect(html).toContain("data-[state=closed]:[animation-fill-mode:forwards]");
    expect(html).toContain("data-[state=closed]:[&amp;&gt;div]:fade-out-0");
    expect(html).toContain("data-[state=closed]:[&amp;&gt;div]:[animation-fill-mode:forwards]");
    expect(html).toContain('data-slot="collapsible-content"');
    expect(html).toContain('data-state="closed"');
    const contentTag = html.match(/<div[^>]*data-slot="collapsible-content"[^>]*>/)?.[0];
    expect(contentTag).toBeDefined();
    expect(contentTag).not.toMatch(/\shidden(?:=|\s|>)/u);
  });

  it("does not expose collapsible animation layers to default CSS transitions", () => {
    const html = renderToStaticMarkup(
      createElement(
        Collapsible,
        { defaultOpen: true },
        createElement(CollapsibleTrigger, null, "Toggle"),
        createElement(CollapsibleContent, null, "Details"),
      ),
    );

    expect(html).toContain("transition-none");
    // 上游把透明度动画改绑到直接子层（[&>div]），避免嵌套 content 的同名 group
    // 匹配到祖先 open 状态、覆盖当前 closed 的淡出。
    expect(html).toContain("data-[state=open]:[&amp;&gt;div]:animate-in");
    expect(html).toContain("data-[state=open]:[&amp;&gt;div]:fade-in-0");
    expect(html).toContain("transition-none duration-300 ease-in-out");
  });
});
