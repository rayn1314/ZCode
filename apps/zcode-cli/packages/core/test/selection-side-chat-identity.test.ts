import assert from "node:assert/strict";
import test from "node:test";

import { createContextBuilder } from "../src/context/builder.js";
import {
  addSelectionSideChatIdentityIfNeeded,
  buildSelectionSideChatIdentitySection,
} from "../src/context/sections/selection-side-chat.js";
import type { ContextBuilderConfig } from "../src/context/types.js";

/**
 * 辅助对话身份段契约（spec: core/spec/selection-side-chat-identity.md）：
 * - 身份段落在 system 层，内容覆盖「辅助角色 / 默认新话题、仅明确要求才续父任务 / 引用块含义」；
 * - 只有 `taskType === "selection_side_chat"` 会注入，其它 taskType 不产生额外段。
 */

const MINIMAL_CONFIG: ContextBuilderConfig = {
  workingDirectory: "E:\\proj",
  envInfo: {
    cwd: "E:\\proj",
    platform: "win32",
    shell: "bash",
    osVersion: "win32 10.0",
    nodeVersion: "v24",
  },
};

function systemContent(config: ContextBuilderConfig, taskType: string | undefined): string {
  const builder = createContextBuilder(config);
  addSelectionSideChatIdentityIfNeeded(builder, taskType);
  return builder
    .build()
    .systemMessages.map((message) => message.content)
    .join("\n");
}

test("身份段本身：system 注入，覆盖角色、默认新话题、仅明确要求才续父任务、引用块说明", () => {
  const section = buildSelectionSideChatIdentitySection();
  assert.equal(section.source, "selection_side_chat_identity");
  assert.equal(section.injectionTarget, "system");
  assert.equal(section.cacheHint, "stable");
  assert.ok(section.content.includes("auxiliary conversation opened from a parent task"));
  assert.ok(section.content.includes("new, independent topics"));
  assert.ok(section.content.includes("only when the user explicitly asks you to take it over"));
  assert.ok(section.content.includes("# userselect:"));
});

test("selection_side_chat 会话：身份段进入 system 消息", () => {
  const content = systemContent(MINIMAL_CONFIG, "selection_side_chat");
  assert.ok(content.includes("auxiliary conversation opened from a parent task"));
  assert.ok(content.includes("# userselect:"));
});

test("非辅助对话：不注入身份段", () => {
  for (const taskType of ["interactive", "subagent_child", "workflow_child", undefined]) {
    const content = systemContent(MINIMAL_CONFIG, taskType);
    assert.ok(!content.includes("auxiliary conversation opened from a parent task"), taskType);
  }
});
