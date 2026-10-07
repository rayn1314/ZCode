// 左栏子代理子区块「点击 → 打开子会话面板 / 子代理目录面板」的入口。
// 与子代理目录面板同一跳转，由 WorkspaceShellLayout 一处裁决；用 context 而不是逐层 props：
// 子区块长在五种任务行里（默认 / 时间线 / 置顶 / 归档 / 分组）。
// 没有 provider（手机远控首页、单测）时子区块只是文字，不是按钮。
//
// 目标里带 workspace 坐标（而不是由壳层补当前 workspace）：左栏是跨 workspace 混排视图
// （grouped 混 workspaceTabs，timeline / pinned / archived 本来就是跨 workspace 查询），
// 父会话可能不属于当前激活的 workspace，壳层无从推断。与 WorkflowRunOpenTarget 同姿态。
import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";

export interface SubagentSessionOpenTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
  childSessionId: string;
  subagentType: string;
  title: string;
}

export interface SubagentDirectoryOpenTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
}

export interface SubagentOpenHandlers {
  onOpenSubagentSession: (target: SubagentSessionOpenTarget) => void;
  onOpenSubagentDirectory: (target: SubagentDirectoryOpenTarget) => void;
}

const SubagentOpenContext = createContext<SubagentOpenHandlers | null>(null);

export function SubagentOpenProvider({
  onOpenSubagentSession,
  onOpenSubagentDirectory,
  children,
}: {
  onOpenSubagentSession: (target: SubagentSessionOpenTarget) => void;
  onOpenSubagentDirectory: (target: SubagentDirectoryOpenTarget) => void;
  children: ReactNode;
}) {
  const sessionRef = useRef(onOpenSubagentSession);
  const directoryRef = useRef(onOpenSubagentDirectory);
  sessionRef.current = onOpenSubagentSession;
  directoryRef.current = onOpenSubagentDirectory;
  // 稳定值 + ref 转发：壳层回调每次 render 都是新引用，直接进 context 会让整棵左栏列表换代重渲染。
  const stable = useMemo<SubagentOpenHandlers>(
    () => ({
      onOpenSubagentSession: (target) => sessionRef.current(target),
      onOpenSubagentDirectory: (target) => directoryRef.current(target),
    }),
    [],
  );
  return <SubagentOpenContext.Provider value={stable}>{children}</SubagentOpenContext.Provider>;
}

export function useSubagentOpen(): SubagentOpenHandlers | null {
  return useContext(SubagentOpenContext);
}
