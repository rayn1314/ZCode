// selection-side-chat 契约测试：身份段进 system 层、只在辅助对话注入。
// 只 import 本模块自己的文件（契约 + 实现），不依赖其它模块的实现。
import { expect, it } from "vitest";
import {
  addSelectionSideChatIdentityIfNeeded,
  buildSelectionSideChatIdentitySection,
  type SelectionSideChatBuilder,
  type SelectionSideChatIdentitySection,
} from "../../src/context/selection-side-chat/contract.js";

/** 只记录 `addSection` 的最小 builder；身份段是否存在只看它收到几次段。 */
function captureSections(): {
  builder: SelectionSideChatBuilder;
  sections: SelectionSideChatIdentitySection[];
} {
  const sections: SelectionSideChatIdentitySection[] = [];
  const builder = {
    addSection: (section: SelectionSideChatIdentitySection) => {
      sections.push(section);
    },
  } as unknown as SelectionSideChatBuilder;
  return { builder, sections };
}

it("身份段进 system 层，且是内容恒定的稳定缓存段", () => {
  const section = buildSelectionSideChatIdentitySection();

  expect(section.injectionTarget).toBe("system");
  expect(section.source).toBe("selection_side_chat_identity");
  expect(section.cacheHint).toBe("stable");
  // 四点身份约束缺一不可：不是主 Agent、父历史只是参考、新话题优先、明确要求才接手父任务。
  expect(section.content).toContain("not the main agent");
  expect(section.content).toContain("new, independent topics");
  expect(section.content).toContain("only when the user explicitly asks");
  // 引用块的含义必须点明：否则模型看不到 `# userselect:` 是什么。
  expect(section.content).toContain("# userselect:");
  expect(section.tokens).toBeGreaterThan(0);
});

it("只对 selection_side_chat 注入；其它 taskType（含缺失）不产生任何段", () => {
  for (const taskType of [undefined, "interactive", "subagent_child", "workflow_child"]) {
    const { builder, sections } = captureSections();
    addSelectionSideChatIdentityIfNeeded(builder, taskType);
    expect(sections).toHaveLength(0);
  }

  const { builder, sections } = captureSections();
  addSelectionSideChatIdentityIfNeeded(builder, "selection_side_chat");
  expect(sections).toHaveLength(1);
  expect(sections[0]?.source).toBe("selection_side_chat_identity");
});
