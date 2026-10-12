import { describe, expect, it } from "vitest";
import { readAskUserQuestionAnswers } from "@/lib/askUserQuestion.js";

// 回答来源的优先级契约：结构化 output > Claude 历史文本格式 > tool input.answers > 无。
// 其中「回读 input.answers」是本地修复（commit 92861c8）：运行时经 permission 流程把答案回填进
// AskUserQuestion 的执行输入，UI 必须能从这里读出答案，否则折叠块会显示「未提供回答」。
// 该断言原先由 packages/ui/test/nonCliAcpRetirement.test.ts 承载，随上游 v3.15.1 删除该文件一起消失，
// 这里单独留一份核心契约。
describe("readAskUserQuestionAnswers", () => {
  const input = { question: "Choose", options: [{ label: "One" }, { label: "Two" }] };

  it("优先取结构化 output 的回答", () => {
    expect(
      readAskUserQuestionAnswers({ input, output: { type: "answered", selected: "One" } }),
    ).toEqual({
      Choose: "One",
    });
    expect(
      readAskUserQuestionAnswers({ input, output: { type: "answered_custom", text: "Custom" } }),
    ).toEqual({ Choose: "Custom" });
  });

  it('兼容 Claude 历史里 `"问题"="答案"` 的文本 output', () => {
    expect(readAskUserQuestionAnswers({ input, output: '"Choose"="One"' })).toEqual({
      Choose: "One",
    });
  });

  it("output 缺席时回读 tool input.answers（权限流程回填的执行输入）", () => {
    expect(
      readAskUserQuestionAnswers({
        input: { ...input, answers: { Choose: "One" } },
      }),
    ).toEqual({ Choose: "One" });
  });

  it("三处都没有答案时返回 undefined", () => {
    expect(readAskUserQuestionAnswers({ input })).toBeUndefined();
    expect(
      readAskUserQuestionAnswers({ input, output: { content: [{ text: "noise" }] } }),
    ).toBeUndefined();
  });
});
