import { MailCheckIcon, MailIcon } from "lucide-react";
import type { AttachmentHoverCardContentProps } from "@/components/ai-elements/attachments.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { SessionMessageEnvelopeReference } from "@/lib/sessionMessageEnvelope.js";
import { ContextAttachmentPill } from "@/v4/composer/ContextAttachmentPill.js";

/** 会话 id 很长，卡片里只给结尾几位，完整值放 title。 */
function shortenSessionId(sessionId: string): string {
  return sessionId.length > 8 ? `…${sessionId.slice(-8)}` : sessionId;
}

export function SessionMessageEnvelopeChip({
  references,
  contentAlign = "start",
}: {
  references: readonly SessionMessageEnvelopeReference[];
  contentAlign?: AttachmentHoverCardContentProps["align"];
}) {
  const { intl } = useZCodeIntl();
  if (references.length === 0) return null;
  // 只有投递回执与真消息分开叫法；其余 source 一律按「来自另一个会话的消息」，
  // 将来新增产出方不需要改这里。
  const allDeliveryResults = references.every(
    (reference) => reference.source === "delivery-result",
  );
  const label = intl.formatMessage(
    allDeliveryResults
      ? { id: "chat.sessionMessage.deliveryResult" }
      : {
          id:
            references.length === 1
              ? "chat.sessionMessage.fromAnotherSession"
              : "chat.sessionMessage.fromAnotherSessionCount",
        },
    { count: String(references.length) },
  );
  return (
    <ContextAttachmentPill
      contentAlign={contentAlign}
      icon={
        allDeliveryResults ? (
          <MailCheckIcon className="size-4 shrink-0 text-foreground-subtle" />
        ) : (
          <MailIcon className="size-4 shrink-0 text-foreground-subtle" />
        )
      }
      label={label}
      triggerProps={{ "data-session-message-envelope-count": references.length }}
    >
      {references.map((reference, index) => (
        <div
          key={reference.messageId || index}
          className="rounded-lg px-2 py-1.5 text-ui-base hover:bg-menu-hover"
        >
          {reference.body ? (
            <div className="line-clamp-3 whitespace-pre-wrap break-words">{reference.body}</div>
          ) : null}
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-ui-sm text-foreground-subtlest">
            {reference.fromSessionId ? (
              <span title={reference.fromSessionId}>
                {shortenSessionId(reference.fromSessionId)}
              </span>
            ) : null}
            {reference.senderKind ? <span>{reference.senderKind}</span> : null}
            {reference.hop ? (
              <span>
                {intl.formatMessage({ id: "chat.sessionMessage.hop" }, { hop: reference.hop })}
              </span>
            ) : null}
          </div>
        </div>
      ))}
    </ContextAttachmentPill>
  );
}
