import {
  buildPromptWithCodeComments,
  parsePromptCodeComments,
  type CodeCommentComposerAttachment,
} from "@/lib/codeCommentContext.js";
import { stripGenUiModelContext } from "@zcode/shared/gen-ui";
import {
  buildPromptWithConversationSelections,
  parsePromptConversationSelections,
  type ConversationSelectionDisplayReference,
} from "@/lib/conversationSelectionReference.js";
import {
  buildPromptWithWebElementContexts,
  parsePromptWebElementContexts,
  type WebElementContextComposerAttachment,
} from "@/lib/webElementContext.js";
import {
  buildPromptWithPptxElementReferences,
  parsePromptPptxElementReferences,
  type PptxElementReference,
} from "@/lib/pptxElementReference.js";
import {
  buildPromptWithSessionMessageEnvelopes,
  parseSessionMessageEnvelopes,
  type SessionMessageEnvelopeReference,
} from "@/lib/sessionMessageEnvelope.js";
import {
  buildPromptWithPluginUiContexts,
  parsePromptPluginUiContexts,
  type PluginUiModelContext,
} from "@/plugin-ui/index.js";

export interface ComposerPromptContexts {
  codeComments: readonly CodeCommentComposerAttachment[];
  conversationSelections: readonly ConversationSelectionDisplayReference[];
  webElements: readonly WebElementContextComposerAttachment[];
  pptxElements: readonly PptxElementReference[];
  sessionMessages: readonly SessionMessageEnvelopeReference[];
  /** 插件 UI 经 ui/update-model-context 附加；缺省视为空。 */
  pluginUiContexts?: readonly PluginUiModelContext[];
}

export function countComposerPromptContexts(contexts: {
  codeComments: readonly unknown[];
  conversationSelections: readonly unknown[];
  webElements: readonly unknown[];
  pptxElements: readonly unknown[];
  sessionMessages: readonly unknown[];
  pluginUiContexts?: readonly unknown[];
}) {
  return (
    contexts.codeComments.length +
    contexts.conversationSelections.length +
    contexts.webElements.length +
    contexts.pptxElements.length +
    contexts.sessionMessages.length +
    (contexts.pluginUiContexts?.length ?? 0)
  );
}

/**
 * 对话流 pill 行实际渲染的上下文类别。
 *
 * 单独成函数是为了让「哪些类别会变成 pill」只有一份定义：2026-10-22 的回归里，
 * `ConversationRowView` 把这套判断内联成逐项枚举，合入上游 v3.15.1 时漏掉了
 * `sessionMessages` 与 `pluginUiContexts`，只含这两类引用的消息行会整行空白
 * （信封被剥掉后没有正文，pill 行又被开关关掉）。
 *
 * 会话引用不在其中：群来源的引用由材料区顶部单独渲染，是否进 pill 行由调用方
 * 按 `botGroupSource` 决定。
 */
export function hasInlineComposerPromptContextPills(
  contexts: Pick<
    ComposerPromptContexts,
    "codeComments" | "webElements" | "pptxElements" | "sessionMessages" | "pluginUiContexts"
  >,
): boolean {
  return (
    contexts.codeComments.length +
      contexts.webElements.length +
      contexts.pptxElements.length +
      contexts.sessionMessages.length +
      (contexts.pluginUiContexts?.length ?? 0) >
    0
  );
}

/**
 * 五类 context parser 都只识别 prompt 尾块，而信封 parser 是全局扫描，因此序列化顺序和解析顺序必须严格相反：
 * 会话消息信封排在序列化最后一步（最外层），解析时就必须最先跑，否则尾块会被当成可见正文拼在信封之后；
 * 插件上下文次外层，紧随其后剥离。
 */
export function serializeComposerPromptContexts(
  text: string,
  contexts: ComposerPromptContexts,
): string {
  const withSelections = buildPromptWithConversationSelections(
    text,
    contexts.conversationSelections,
  );
  const withCodeComments = buildPromptWithCodeComments(withSelections, contexts.codeComments);
  const withWebElements = buildPromptWithWebElementContexts(withCodeComments, contexts.webElements);
  const withPptx = buildPromptWithPptxElementReferences(withWebElements, contexts.pptxElements);
  const withPlugin = buildPromptWithPluginUiContexts(withPptx, contexts.pluginUiContexts ?? []);
  return buildPromptWithSessionMessageEnvelopes(withPlugin, contexts.sessionMessages);
}

export function parseComposerPromptContexts(
  content: string,
  workspace: { workspacePath: string; workspaceIdentity?: string },
): {
  visibleContent: string;
  codeComments: CodeCommentComposerAttachment[];
  conversationSelections: readonly ConversationSelectionDisplayReference[];
  webElements: WebElementContextComposerAttachment[];
  pptxElements: PptxElementReference[];
  sessionMessages: SessionMessageEnvelopeReference[];
  pluginUiContexts: PluginUiModelContext[];
} {
  const sessionMessages = parseSessionMessageEnvelopes(content);
  const plugin = parsePromptPluginUiContexts(
    stripGenUiModelContext(sessionMessages.visibleContent),
  );
  const pptx = parsePromptPptxElementReferences(plugin.visibleContent);
  const web = parsePromptWebElementContexts(pptx.visibleContent, workspace);
  const code = parsePromptCodeComments(web.visibleContent, workspace);
  const selections = parsePromptConversationSelections(code.visibleContent);
  return {
    visibleContent: selections.visibleContent,
    codeComments: code.codeCommentAttachments,
    conversationSelections: selections.references,
    webElements: web.webElementContexts,
    pptxElements: pptx.pptxElementReferences,
    sessionMessages: sessionMessages.messages,
    pluginUiContexts: plugin.pluginUiContexts,
  };
}
