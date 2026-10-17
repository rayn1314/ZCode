import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { useShallow } from "zustand/react/shallow";
import {
  resolveGenUiTargetRemoteIdentity,
  type GenUiRemoteIdentity,
} from "@/gen-ui/domain/remoteIdentity.js";

/**
 * 侧聊/fork 会话渲染链可能丢远端身份透传，这里按 workspacePath 从 tab 快照兜底借身份，
 * 避免 Gen UI 服务解析回落到本机 base services（读端变 Windows 根导致越界）。
 *
 * 派生结果是新对象，必须经 useShallow：zustand v5 把 selector 结果直接当
 * useSyncExternalStore 的 getSnapshot，返回新引用会被判定为快照恒变而无限重渲染
 * （React #185 Maximum update depth exceeded）。
 */
export function useGenUiRemoteIdentity(target: {
  workspacePath?: string | null;
  workspaceIdentity?: string | null;
  remoteSessionId?: string | null;
}): GenUiRemoteIdentity | null {
  return useTabStore(
    useShallow((state) =>
      resolveGenUiTargetRemoteIdentity({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        remoteSessionId: target.remoteSessionId,
        workspaceTabs: state.tabs.filter(isWorkspaceTab),
      }),
    ),
  );
}
