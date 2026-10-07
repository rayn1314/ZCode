/**
 * 左栏父条目**下方**的子代理子区块（spec: 「左栏任务列表：层级态」）。
 *
 * 只在父条目被选中时挂载；父条目未选中时的可见性由角标承担（`SessionSummary.runningSubagentCount`）。
 *
 * 数据面自带一层 `V4PaneConversationProvider`：左栏子树不在任何 V4 conversation provider 内
 * （provider 只挂 chat pane 与各 side pane），而区块要读父会话投影 `snapshot.subagents`。
 * 这层不新开连接——`acquireWorkspaceConnection` 按 endpoint+workspaceKey 租用并 refCount，
 * 父会话通常已被主面板订阅。远端 workspace 未就绪时该 provider 返回 null，区块自然不渲染
 * （fail-closed，与子代理目录面板一致）。
 */
import { memo, useEffect, useMemo, useState } from "react";
import type { RunningSubagentSummary } from "@zcode/shared/zcode-protocol-v4";
import { BotIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { useSessionSubagents } from "@/hooks/useSessionSubagents.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { buildSubagentSubBlockRows, type SubagentSubBlockRow } from "@/v4/subagentSubBlockModel.js";
import { useSubagentOpen } from "@/v4/subagentOpenContext.js";
import { SubagentStatusIcon } from "@/v4/SubagentStatusIcon.js";
import { V4PaneConversationProvider, useV4Conversation } from "@/v4/V4ConversationContext.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";

/** 区块里最多列出的已结束子代理数；更多的走「还有 N 个」→ 目录面板。 */
const ENDED_ROW_LIMIT = 8;

const EMPTY_RUNNING: readonly RunningSubagentSummary[] = [];

/**
 * 区块统一缩进一级：与 timeline 行的标题起点对齐，在 grouped 里表现为比父行深一层。
 * 字号不放在这里——行与「还有 N 个」那一行字号不同，两个同族 text-* 类共存时
 * 谁生效取决于样式表顺序而不是 class 顺序。
 */
const ROW_LAYOUT_CLASS =
  "flex h-6 w-full min-w-0 items-center gap-2 rounded-md pl-8 pr-1.5 text-left";
const ROW_BASE_CLASS = cn(ROW_LAYOUT_CLASS, "text-ui-base");
const ROW_INTERACTIVE_CLASS = cn(
  ROW_BASE_CLASS,
  "text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-border-focused",
);

/**
 * 行 / 按钮的点击穿透隔离。
 *
 * 父行自己带 `onClick={handleSelect}`（GroupedTaskRow 的 role=button、TaskListItem 的 `<li>`），
 * 区块是父行的兄弟节点但仍在同一个包装元素内，事件会冒泡上去再选一次父会话。
 * pointer 系列一起挡：dnd-kit 与原生拖拽在 pointerdown 阶段就可能开始跟踪。
 */
function stopRowPropagation(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}

const SUBAGENT_ROW_STOP_HANDLERS = {
  onMouseDown: stopRowPropagation,
  onPointerDown: stopRowPropagation,
  onTouchStart: stopRowPropagation,
} as const;

function SubagentRowContent({ row }: { row: SubagentSubBlockRow }) {
  const { intl } = useZCodeIntl();
  return (
    <>
      <BotIcon aria-hidden className="size-3.5 shrink-0 text-foreground-subtle" />
      <span className="min-w-0 flex-1 truncate">{row.title}</span>
      {/* 右侧状态只有一个图标，必须配无障碍名（不单靠颜色/图形区分状态）。 */}
      <span className="shrink-0 text-foreground-subtle">
        <SubagentStatusIcon
          status={row.status}
          label={intl.formatMessage({ id: row.statusMessageId })}
        />
      </span>
    </>
  );
}

export const SubagentSubBlock = memo(function SubagentSubBlock({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  parentSessionId,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
}) {
  const scope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
    }),
    [remoteSessionId, workspaceIdentity, workspacePath],
  );
  return (
    <V4PaneConversationProvider scope={scope}>
      <SubagentSubBlockContents
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        remoteSessionId={remoteSessionId}
        parentSessionId={parentSessionId}
      />
    </V4PaneConversationProvider>
  );
});

const SubagentSubBlockContents = memo(function SubagentSubBlockContents({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  parentSessionId,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
}) {
  const { intl } = useZCodeIntl();
  const handlers = useSubagentOpen();
  const { layer } = useV4Conversation();
  const [parentLease, setParentLease] = useState<SessionLease | null>(null);
  useEffect(() => {
    // 与 SubagentDirectorySidePane 逐字相同的读法：租约引用计数，不额外建连。
    const nextLease = layer.acquire(parentSessionId);
    setParentLease(nextLease);
    return () => nextLease.release();
  }, [layer, parentSessionId]);
  const parentSnapshot = useConversationProjection(parentLease).snapshot;
  const subagents = parentSnapshot?.subagents;
  const directory = useSessionSubagents({
    enabled: parentSnapshot !== null,
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    sessionId: parentSessionId,
    refreshKey: subagents?.revision ?? 0,
  });
  const model = buildSubagentSubBlockRows({
    running: subagents?.running ?? EMPTY_RUNNING,
    endedItems: directory.ended.items,
    endedTotal: subagents?.endedTotal ?? 0,
    limit: ENDED_ROW_LIMIT,
  });

  // 租约是同步取得的，这一帧渲染还不存在，直接不出东西——避免每次切换父条目都闪一下占位。
  if (parentLease === null) {
    return null;
  }
  // 租约在手但投影还没到 = 确实一点数据都没有：这时才放占位。
  // 已有数据（父条目重选、ended 分页刷新）时一律不闪占位。
  if (parentSnapshot === null) {
    return (
      <div
        data-testid="v4-task-subagent-block-loading"
        className="flex flex-col gap-0.5 py-0.5"
        aria-hidden
      >
        <div className="h-6 animate-pulse rounded-md bg-surface-hover" />
        <div className="h-6 animate-pulse rounded-md bg-surface-hover" />
      </div>
    );
  }

  const failureLine = directory.error ? (
    <div className="flex items-center gap-2 py-0.5 pl-8 pr-1.5">
      <span
        data-testid="v4-task-subagent-block-error"
        className="text-ui-xs text-foreground-subtle"
      >
        {intl.formatMessage({ id: "subagents.list.loadFailed" })}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 px-1.5 text-ui-xs"
        onClick={(event) => {
          stopRowPropagation(event);
          void directory.refresh();
        }}
        {...SUBAGENT_ROW_STOP_HANDLERS}
      >
        {intl.formatMessage({ id: "subagents.list.retry" })}
      </Button>
    </div>
  ) : null;

  // 空：不渲染区块，不留空态占位。故障态自己成行，不能被"空"这条吞掉。
  if (model.rows.length === 0 && !failureLine) {
    return null;
  }

  return (
    <div data-testid="v4-task-subagent-block" className="flex flex-col gap-0.5 py-0.5">
      {model.rows.map((row) =>
        handlers ? (
          <button
            key={row.childSessionId}
            type="button"
            data-testid="v4-task-subagent-row"
            className={ROW_INTERACTIVE_CLASS}
            onClick={(event) => {
              stopRowPropagation(event);
              handlers.onOpenSubagentSession({
                workspacePath,
                ...(workspaceIdentity ? { workspaceIdentity } : {}),
                ...(remoteSessionId ? { remoteSessionId } : {}),
                parentSessionId,
                childSessionId: row.childSessionId,
                subagentType: row.subagentType,
                title: row.title,
              });
            }}
            {...SUBAGENT_ROW_STOP_HANDLERS}
          >
            <SubagentRowContent row={row} />
          </button>
        ) : (
          // 无 provider（手机远控首页、静态渲染、单测）时退化成文字：给一个点不动的入口是骗人。
          <div
            key={row.childSessionId}
            data-testid="v4-task-subagent-row"
            className={cn(ROW_BASE_CLASS, "text-foreground-subtle")}
          >
            <SubagentRowContent row={row} />
          </div>
        ),
      )}
      {model.hiddenEndedCount > 0 ? (
        handlers ? (
          <button
            type="button"
            data-testid="v4-task-subagent-more"
            className={cn(
              ROW_LAYOUT_CLASS,
              "text-ui-sm text-foreground-subtlest transition-colors hover:text-foreground-subtle focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-border-focused",
            )}
            onClick={(event) => {
              stopRowPropagation(event);
              handlers.onOpenSubagentDirectory({
                workspacePath,
                ...(workspaceIdentity ? { workspaceIdentity } : {}),
                ...(remoteSessionId ? { remoteSessionId } : {}),
                parentSessionId,
              });
            }}
            {...SUBAGENT_ROW_STOP_HANDLERS}
          >
            {intl.formatMessage(
              { id: "subagents.list.moreEnded" },
              { count: String(model.hiddenEndedCount) },
            )}
          </button>
        ) : (
          <div
            data-testid="v4-task-subagent-more"
            className={cn(ROW_LAYOUT_CLASS, "text-ui-sm text-foreground-subtlest")}
          >
            {intl.formatMessage(
              { id: "subagents.list.moreEnded" },
              { count: String(model.hiddenEndedCount) },
            )}
          </div>
        )
      ) : null}
      {failureLine}
    </div>
  );
});
