import { memo, useEffect, useMemo, useState } from "react";
import type { PendingInteraction } from "@zcode/shared/zcode-protocol-v4";
import { BotIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type {
  OpenScopedSubagentSideTabRequest,
  OpenBackgroundBashSideTabRequest,
  SubagentSessionSidePaneTab,
} from "@/lib/workspaceSidePane.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { SessionPane } from "@/v4/SessionPane.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import { V4PaneConversationProvider, useV4Conversation } from "@/v4/V4ConversationContext.js";

/** 点击提示后要切到的父会话坐标，由宿主（WorkspaceShellLayout）翻译成标签页导航。 */
export interface OpenParentSessionTarget {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

/**
 * 属于某个 child 的待处理交互计数。
 *
 * 判据与 CLI 侧 product-projection 的 `waitingChildIds` 逐字对齐（同一份
 * `pendingInteractions` 投影，两处口径不能分叉）：`workspaceHookReview` 的 payload 没有
 * `origin` 字段，先守卫再读；只有 `origin.kind === "subagent"` 且 childSessionId 相同才算。
 */
function countChildPendingInteractions(
  interactions: readonly PendingInteraction[],
  childSessionId: string,
): number {
  let count = 0;
  for (const interaction of interactions) {
    if (!("origin" in interaction.payload)) continue;
    const origin = interaction.payload.origin;
    if (origin?.kind === "subagent" && origin.childSessionId === childSessionId) count += 1;
  }
  return count;
}

/**
 * 子会话面板顶部条：身份（图标 + 标题 + agentType 徽标）+ 运行态词 + 授权请求提示。
 *
 * **父会话租约与投影订阅在顶部条内部**，不在外层：外层订阅会让父会话的每次投影增量都把整棵
 * `SessionPane` 拖着重渲染（子 pane 的实时流不该被父会话的活动带着走）。订阅只影响这一条。
 *
 * 状态词读**父会话投影**里的 `subagents.running`，不是新订阅子会话：
 * - 子会话自己的 `Snapshot` 在 `SessionPane` 内部，这里再取一份等于多一份租约；
 * - 父投影本来就是"这个 child 现在什么状态"的权威事实源（`materializeSubagentProjection`），
 *   授权提示也用同一份读取。
 *
 * 未命中 running 列表时判「已结束」。这同时承担了 spec 里「已终止摘要」的职责：composer 占着
 * 面板底部，再摆一条底栏会和它抢位置，而"这个子代理已结束"在打开面板时最该一眼看到。
 */
const SubagentPaneTopStrip = memo(function SubagentPaneTopStrip({
  tab,
  onOpenParentSession,
}: {
  tab: SubagentSessionSidePaneTab;
  onOpenParentSession?: (target: OpenParentSessionTarget) => void;
}) {
  const { intl } = useZCodeIntl();
  const { layer } = useV4Conversation();
  // 写法与 SubagentDirectorySidePane 一致：租约引用计数，父会话通常已被主面板订阅，不额外建连。
  const [parentLease, setParentLease] = useState<SessionLease | null>(null);
  useEffect(() => {
    const nextLease = layer.acquire(tab.parentSessionId);
    setParentLease(nextLease);
    return () => nextLease.release();
  }, [layer, tab.parentSessionId]);
  const parentSnapshot = useConversationProjection(parentLease).snapshot;

  const runningSubagent = parentSnapshot?.subagents?.running.find(
    (item) => item.childSessionId === tab.childSessionId,
  );
  // 父投影未就绪时不出状态词：闪一个错的「已结束」比晚一帧出现更糟。
  const statusMessageId =
    parentLease === null
      ? null
      : runningSubagent === undefined
        ? "subagents.pane.status.ended"
        : `subagents.pane.status.${runningSubagent.status}`;
  const pendingCount = parentSnapshot
    ? countChildPendingInteractions(parentSnapshot.pendingInteractions, tab.childSessionId)
    : 0;
  const handleOpenParent = () => {
    onOpenParentSession?.({
      sessionId: tab.parentSessionId,
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    });
  };

  return (
    <div
      data-testid="v4-subagent-pane-top-strip"
      className="flex min-w-0 shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2"
    >
      <BotIcon aria-hidden className="size-4 shrink-0 text-foreground-subtle" />
      <span className="min-w-0 flex-1 truncate text-ui-base font-medium text-foreground">
        {tab.title}
      </span>
      {statusMessageId ? (
        <span className="shrink-0 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: statusMessageId })}
        </span>
      ) : null}
      <Badge variant="secondary" className="shrink-0">
        {intl.formatMessage(
          { id: "subagents.pane.identityBadge" },
          { agentType: tab.subagentType },
        )}
      </Badge>
      {/* 无待处理请求时整块不渲染（不留空占位）。等待确认色族与所有 waiting badge 一致，
          不得用 success 色族顶替（DESIGN.md 的 Blocking interaction colors）。 */}
      {pendingCount > 0 && onOpenParentSession ? (
        <button
          type="button"
          data-testid="v4-subagent-pane-pending-in-parent"
          onClick={handleOpenParent}
          className="w-full rounded-lg bg-interaction-confirmation-surface px-2 py-1.5 text-left text-ui-sm text-interaction-confirmation-foreground transition-colors hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
        >
          {intl.formatMessage({ id: "subagents.pane.pendingInParent" }, { count: pendingCount })}
        </button>
      ) : null}
    </div>
  );
});

const SubagentSessionContent = memo(function SubagentSessionContent({
  tab,
  focused,
  compactForRemoteControl = false,
  onOpenBrowserUrl,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenSubagentSession,
  onOpenBackgroundBash,
  onOpenParentSession,
}: {
  tab: SubagentSessionSidePaneTab;
  focused: boolean;
  compactForRemoteControl?: boolean;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenBackgroundBash?: (request: OpenBackgroundBashSideTabRequest) => void;
  onOpenSubagentSession: (request: OpenScopedSubagentSideTabRequest) => void;
  onOpenParentSession?: (target: OpenParentSessionTarget) => void;
}) {
  return (
    <SessionPane
      paneId={tab.id}
      sessionId={tab.childSessionId}
      openTrigger="subagent"
      rootSessionId={tab.rootSessionId}
      compactForRemoteControl={compactForRemoteControl}
      // 子会话面板一律 subagentChild，本地与远端 workspace 一视同仁：UI 输入走 v4 `sendText`
      // （按 scope 连到目标 workspace 的会话层），父子协作走进程内 `coordinatorResponsePort`，
      // 都不依赖跨机器共享的 mailbox。原「远端则 observe」的判据建立在"父↔子 mailbox 不跨机器
      // 共享"这一前提上，而该前提对 UI 输入路径不成立（远端 server 已受理子会话 sendText，
      // 见 session_input kind=sendText/status=promoted 的既有记录）。真正不可输入的只有受限模式
      // （读不到 launch spec），由 inputRouting.mode="reject" 与准入层强制，与远端与否无关。
      shape="subagentChild"
      allowWorkspaceFileRewind
      paneTopStrip={
        <SubagentPaneTopStrip tab={tab} {...(onOpenParentSession ? { onOpenParentSession } : {})} />
      }
      focused={focused}
      telemetryVisible={focused}
      workspacePath={tab.workspacePath}
      workspaceIdentity={tab.workspaceIdentity}
      remoteSessionId={tab.remoteSessionId}
      onOpenBrowserUrl={onOpenBrowserUrl}
      onOpenCodeViewer={onOpenCodeViewer}
      onOpenFileLink={onOpenFileLink}
      onOpenSubagentSession={onOpenSubagentSession}
      onOpenBackgroundBash={onOpenBackgroundBash}
    />
  );
});

export const SubagentSessionSidePane = memo(function SubagentSessionSidePane({
  tab,
  focused,
  compactForRemoteControl = false,
  onOpenBrowserUrl,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenSubagentSession,
  onOpenBackgroundBash,
  onOpenParentSession,
}: {
  tab: SubagentSessionSidePaneTab;
  focused: boolean;
  compactForRemoteControl?: boolean;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenBackgroundBash?: (request: OpenBackgroundBashSideTabRequest) => void;
  onOpenSubagentSession: (request: OpenScopedSubagentSideTabRequest) => void;
  onOpenParentSession?: (target: OpenParentSessionTarget) => void;
}) {
  const scope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    }),
    [tab.remoteSessionId, tab.workspaceIdentity, tab.workspacePath],
  );

  return (
    <V4PaneConversationProvider scope={scope}>
      <SubagentSessionContent
        tab={tab}
        focused={focused}
        compactForRemoteControl={compactForRemoteControl}
        onOpenBrowserUrl={onOpenBrowserUrl}
        onOpenCodeViewer={onOpenCodeViewer}
        onOpenFileLink={onOpenFileLink}
        onOpenSubagentSession={onOpenSubagentSession}
        onOpenBackgroundBash={onOpenBackgroundBash}
        {...(onOpenParentSession ? { onOpenParentSession } : {})}
      />
    </V4PaneConversationProvider>
  );
});
