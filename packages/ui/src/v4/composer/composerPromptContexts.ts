import {
  buildPromptWithCodeComments,
  parsePromptCodeComments,
  type CodeCommentComposerAttachment,
} from "@/lib/codeCommentContext.js";
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

interface ComposerPromptContexts {
  codeComments: readonly CodeCommentComposerAttachment[];
  conversationSelections: readonly ConversationSelectionDisplayReference[];
  webElements: readonly WebElementContextComposerAttachment[];
  pptxElements: readonly PptxElementReference[];
  sessionMessages: readonly SessionMessageEnvelopeReference[];
}

export function countComposerPromptContexts(contexts: {
  codeComments: readonly unknown[];
  conversationSelections: readonly unknown[];
  webElements: readonly unknown[];
  pptxElements: readonly unknown[];
  sessionMessages: readonly unknown[];
}) {
  return (
    contexts.codeComments.length +
    contexts.conversationSelections.length +
    contexts.webElements.length +
    contexts.pptxElements.length +
    contexts.sessionMessages.length
  );
}

/**
 * 四类尾块 parser 只识别 prompt 尾块，而信封 parser 是全局扫描，因此序列化顺序和解析顺序必须严格相反：
 * 会话消息信封排在序列化最后一步，解析时就必须最先跑，否则尾块会被当成可见正文拼在信封之后。
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
  const withPptxElements = buildPromptWithPptxElementReferences(
    withWebElements,
    contexts.pptxElements,
  );
  return buildPromptWithSessionMessageEnvelopes(withPptxElements, contexts.sessionMessages);
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
} {
  const sessionMessages = parseSessionMessageEnvelopes(content);
  const pptx = parsePromptPptxElementReferences(sessionMessages.visibleContent);
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
  };
}
