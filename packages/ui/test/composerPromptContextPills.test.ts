import { describe, expect, it } from "vitest";
import {
  hasInlineComposerPromptContextPills,
  type ComposerPromptContexts,
} from "@/v4/composer/composerPromptContexts.js";

function emptyContexts(): ComposerPromptContexts {
  return {
    codeComments: [],
    conversationSelections: [],
    webElements: [],
    pptxElements: [],
    sessionMessages: [],
    pluginUiContexts: [],
  };
}

/** 该判断只读各类别的长度，元素形状与是否计入无关。 */
const pillCategories = [
  "codeComments",
  "webElements",
  "pptxElements",
  "sessionMessages",
  "pluginUiContexts",
] as const satisfies readonly (keyof ComposerPromptContexts)[];

describe("hasInlineComposerPromptContextPills", () => {
  // 回归：合入上游 v3.15.1 时 ConversationRowView 的逐项枚举漏了两类，
  // 只含该类引用的消息行整行空白。每个类别都必须单独计入。
  it.each(pillCategories)("counts %s on its own", (category) => {
    const contexts = { ...emptyContexts(), [category]: [{}] } as unknown as ComposerPromptContexts;
    expect(hasInlineComposerPromptContextPills(contexts)).toBe(true);
  });

  it("returns false when every pill category is empty", () => {
    expect(hasInlineComposerPromptContextPills(emptyContexts())).toBe(false);
  });

  it("treats a missing pluginUiContexts as empty", () => {
    const { pluginUiContexts: _omitted, ...withoutPlugin } = emptyContexts();
    expect(hasInlineComposerPromptContextPills(withoutPlugin)).toBe(false);
  });

  it("ignores conversation selections, which the caller routes by bot group source", () => {
    const contexts = {
      ...emptyContexts(),
      conversationSelections: [{}],
    } as unknown as ComposerPromptContexts;
    expect(hasInlineComposerPromptContextPills(contexts)).toBe(false);
  });
});
