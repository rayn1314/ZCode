import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useOptionalPlatform } from "./usePlatform.js";
import {
  useOptionalBaseWorkspaceServices,
  useWorkspaceServicesResolution,
} from "./useWorkspaceServices.js";
import { acquireGenUiPage, type GenUiCardTarget, type RetainedGenUiPage } from "@/gen-ui/host.js";
import { resolveGenUiTargetRemoteIdentity } from "@/gen-ui/domain/remoteIdentity.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
export function useGenUi(
  target: GenUiCardTarget,
  confirm: (prompt: string) => Promise<string | null>,
  retry: number,
) {
  const platformService = useOptionalPlatform();
  const platform = platformService?.pluginSandbox;
  const services = useOptionalBaseWorkspaceServices();
  const state = services?.genUiService;
  // 侧聊/fork 会话渲染链可能丢远端身份透传，tab 快照按 workspacePath 兜底借身份，
  // 避免服务解析回落到本机 base services（读端变 Windows 根导致越界）。
  const fallbackIdentity = useTabStore((state) =>
    resolveGenUiTargetRemoteIdentity({
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      remoteSessionId: target.remoteSessionId,
      workspaceTabs: state.tabs.filter(isWorkspaceTab),
    }),
  );
  const resolution = useWorkspaceServicesResolution(
    target.workspacePath,
    target.remoteSessionId ?? fallbackIdentity?.remoteSessionId,
    target.workspaceIdentity ?? fallbackIdentity?.workspaceIdentity,
    fallbackIdentity?.remoteTarget,
  );
  const files = resolution.services.genUiService;
  const [result, setResult] = useState<{
    key: string;
    page: RetainedGenUiPage | null;
    error?: string;
  }>({ key: "", page: null });
  const targetRef = useRef(target);
  targetRef.current = target;
  const key = JSON.stringify(target);
  useEffect(() => {
    if (!platformService || !platform || !state || !files || !resolution.rpcReady) {
      setResult({ key, page: null });
      return;
    }
    let cancelled = false;
    const currentTarget = targetRef.current;
    void acquireGenUiPage({
      target: currentTarget,
      platform,
      state,
      files,
      openExternal: (url) => platformService.openExternal(url),
      watchTaskRemoved(run) {
        const subscription = services?.zcodeTaskService?.onDynamicWorkspaceEvent({
          workspacePath: currentTarget.workspacePath,
          workspaceIdentity: currentTarget.workspaceIdentity,
        })((event) => {
          if (
            event.type === "workspace_task_list_changed" &&
            event.reason === "task_deleted" &&
            event.taskId === currentTarget.sessionId
          )
            run();
        });
        return () => subscription?.dispose();
      },
    }).then(
      (owner) => {
        if (!cancelled) {
          if (retry && owner.getSnapshot().phase === "error") owner.retry();
          setResult({ key, page: owner });
        }
      },
      (error) => {
        if (!cancelled) setResult({ key, page: null, error: String(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, platformService, platform, state, files, services, retry, resolution.rpcReady]);
  const page = key === result.key ? result.page : null;
  useLayoutEffect(() => page?.attachConfirmation(confirm), [page, confirm]);
  return {
    page,
    error: key === result.key ? result.error : undefined,
    supported: Boolean(platform),
    online: resolution.rpcReady,
  };
}
