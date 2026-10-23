import { useCallback, useMemo, useState } from "react";
import { CheckCheck, Copy } from "lucide-react";
import type { ProjectRowAction, ProjectTask, VirtualProject } from "@/project-sidebar/contract.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";
import {
  markTaskQueryCacheScopesStale,
  reconcileTaskQueryCacheUnread,
  rollbackTaskQueryCacheUnread,
  setTaskQueryCacheUnreadOverlay,
} from "@/store/taskQueryCacheStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { bumpTaskListMembershipVersion } from "@/v4/taskListMembershipVersion.js";

type WorkspaceTarget = { workspacePath: string; workspaceIdentity?: string };

function targetKey(target: WorkspaceTarget): string {
  return `${target.workspaceIdentity ?? ""}\0${target.workspacePath}`;
}

/**
 * 项目行的本 fork 操作：复制路径、全部标为已读。
 *
 * 「全部标为已读」沿用旧侧栏的完整语义，而不是只发一次请求就 `refresh()`：
 * - 先对可见未读行做乐观清除（overlay + 行指示器），失败再回滚；
 * - 服务端单事务清完整个口径，回包带回分页窗口之外的 taskId，逐个对账收蓝点；
 * - 必须 bump membership 版本，项目行蓝点只在 membership 重拉时重算。
 *
 * 按项目任务实际携带的 (workspacePath, workspaceIdentity) 逐组清除，而不是用项目 root 拼地址：
 * 远端 server 身份的格式只有落库值可信（`remote:server:<id>:<path>`），客户端拼错会命中另一个 source。
 */
export function useProjectWorkspaceActions(
  project: VirtualProject,
  tasks: ProjectTask[],
  hasUnread: boolean,
  online: boolean,
  refresh: () => Promise<void>,
): ProjectRowAction[] {
  const { intl } = useZCodeIntl();
  const { zcodeTaskService } = useBaseWorkspaceServices();
  const setTaskUnreadIndicator = useZCodeSessionStore((state) => state.setTaskUnreadIndicator);
  const [marking, setMarking] = useState(false);

  const copyPath = useCallback(
    (workspacePath: string) => {
      if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
        toast(intl.formatMessage({ id: "workspaceSidebar.copyPathFailed" }));
        logger.warn("[project-sidebar] 复制路径失败：剪贴板不可用", { workspacePath });
        return;
      }
      void navigator.clipboard.writeText(workspacePath).then(
        () => toast(intl.formatMessage({ id: "workspaceSidebar.copyPathDone" })),
        (error: unknown) => {
          toast(intl.formatMessage({ id: "workspaceSidebar.copyPathFailed" }));
          logger.warn("[project-sidebar] 复制路径失败", { workspacePath }, error);
        },
      );
    },
    [intl],
  );

  const targets = useMemo(() => {
    const seen = new Map<string, WorkspaceTarget>();
    for (const task of tasks) {
      const target: WorkspaceTarget = {
        workspacePath: task.workspacePath,
        ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
      };
      seen.set(targetKey(target), target);
    }
    return [...seen.values()];
  }, [tasks]);

  const markAllRead = useCallback(async () => {
    if (!targets.length || marking) return;
    const visibleUnread = tasks.filter((task) => typeof task.unreadAt === "number");
    for (const task of visibleUnread) {
      setTaskQueryCacheUnreadOverlay(task, undefined);
      setTaskUnreadIndicator(task.workspacePath, task.taskId, false, task.workspaceIdentity);
    }
    setMarking(true);
    try {
      const clearedOutsideWindow: Array<{ taskId: string; target: WorkspaceTarget }> = [];
      for (const target of targets) {
        const { clearedTaskIds } = await zcodeTaskService.markWorkspaceTasksRead(target);
        for (const taskId of clearedTaskIds) {
          clearedOutsideWindow.push({ taskId, target });
        }
      }
      // 分页窗口之外的未读不在可见列表里，只能靠回包带回的 taskId 收蓝点；已处理过的可见行重复对账无害。
      const seen = new Set(visibleUnread.map((task) => `${targetKey(task)}\0${task.taskId}`));
      for (const task of visibleUnread) {
        reconcileTaskQueryCacheUnread(task, undefined);
      }
      for (const { taskId, target } of clearedOutsideWindow) {
        const key = `${targetKey(target)}\0${taskId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        reconcileTaskQueryCacheUnread({ taskId, ...target }, undefined);
        setTaskUnreadIndicator(target.workspacePath, taskId, false, target.workspaceIdentity);
      }
      // 项目行蓝点还依赖 unreadTaskKeys，而它只在 membership 重拉时重算，必须 bump。
      bumpTaskListMembershipVersion();
      // 清除是权威事实，项目树重查失败不能改写成功结果。
      await refresh().catch((error: unknown) => {
        logger.warn("[project-sidebar] 全部标为已读后刷新失败", { projectId: project.id }, error);
      });
    } catch (error) {
      for (const task of visibleUnread) {
        rollbackTaskQueryCacheUnread(task, task.unreadAt);
        setTaskUnreadIndicator(task.workspacePath, task.taskId, true, task.workspaceIdentity);
      }
      markTaskQueryCacheScopesStale(targets);
      bumpTaskListMembershipVersion();
      toast(intl.formatMessage({ id: "workspaceSidebar.markAllAsReadFailed" }));
      logger.warn(
        "[project-sidebar] 全部标为已读失败",
        { projectId: project.id, hostId: project.hostId },
        error,
      );
    } finally {
      setMarking(false);
    }
  }, [
    intl,
    marking,
    project.hostId,
    project.id,
    refresh,
    setTaskUnreadIndicator,
    targets,
    tasks,
    zcodeTaskService,
  ]);

  return useMemo(() => {
    const roots = project.roots;
    const copyActions: ProjectRowAction[] = roots.map((root, index) => ({
      id: `copy-path-${index}`,
      // 多 root 项目与「显示文件」一致：同名操作带上路径，否则用户无法区分复制的是哪一份。
      label:
        roots.length > 1
          ? `${intl.formatMessage({ id: "appHeader.copyPath" })} · ${root.rootPath}`
          : intl.formatMessage({ id: "appHeader.copyPath" }),
      icon: Copy,
      run: () => copyPath(root.rootPath),
    }));
    return [
      ...copyActions,
      {
        id: "mark-all-read",
        label: intl.formatMessage({ id: "workspaceSidebar.markAllAsRead" }),
        icon: CheckCheck,
        // 与旧侧栏一致：没有未读时按钮照常可见，用禁用态解释为什么点了没反应。
        disabled: !online || !hasUnread || marking,
        run: () => {
          void markAllRead();
        },
      },
    ];
  }, [copyPath, hasUnread, intl, markAllRead, marking, online, project.roots]);
}
