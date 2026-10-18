import { useMemo } from "react";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { InstructionScopeCard } from "@/settings/InstructionScopeCard.js";
import { resolveInstructionsService } from "@/settings/instructionFiles.js";

interface InstructionFilesSectionProps {
  workspacePath?: string | null;
  workspaceIdentity?: string;
  /**
   * 指令文件是 host 机器上的真实文件：只有桌面端能读写并唤起外部编辑器。
   * Web Remote / 手机只看提示，不解析服务、不发任何 RPC。
   */
  fileManagementAvailable: boolean;
}

/**
 * 设置页「指令」分区：管理用户级与仓库级 AGENTS.md。
 * 两张卡的顺序即生效顺序（仓库级优先于用户级），顺序不在 UI 内调整。
 */
export function InstructionFilesSection({
  workspacePath,
  workspaceIdentity,
  fileManagementAvailable,
}: InstructionFilesSectionProps) {
  // 分层先例同 WorkspaceFileSearchSection：不可用态直接返回提示组件，
  // 不挂 services / tabStore 解析链，保证 Web Remote / 手机零服务调用。
  if (!fileManagementAvailable) {
    return <InstructionFilesPlaceholder messageId="settings.instructions.desktopOnly" boxed />;
  }
  if (!workspacePath) {
    // 冻结契约里读取与写入都需要 workspacePath（用于解析 host 侧路径），
    // 因此没有工作区时用户级文件也无法管理，这里统一给空态而不是半张卡。
    return <InstructionFilesPlaceholder messageId="settings.instructions.noWorkspace" />;
  }
  return (
    <ActiveInstructionFilesEditor
      workspacePath={workspacePath}
      workspaceIdentity={workspaceIdentity}
    />
  );
}

function InstructionFilesPlaceholder({
  messageId,
  boxed = false,
}: {
  messageId: string;
  boxed?: boolean;
}) {
  const { intl } = useZCodeIntl();
  if (boxed) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-transparent px-4 py-8 text-center text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: messageId })}
      </div>
    );
  }
  return (
    <p className="text-ui-base leading-6 text-foreground-subtle">
      {intl.formatMessage({ id: messageId })}
    </p>
  );
}

function ActiveInstructionFilesEditor({
  workspacePath,
  workspaceIdentity,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
}) {
  const { intl } = useZCodeIntl();
  const resolution = useWorkspaceServicesResolution(workspacePath, undefined, workspaceIdentity);
  // 服务解析只做一次：两张卡共享同一份 host 侧服务与连接态，避免同一 workspace 出现两种读到结果。
  const instructionsService = useMemo(
    () => resolveInstructionsService(resolution.services),
    [resolution.services],
  );

  return (
    <div className="space-y-6" data-testid="instructions-settings-section">
      <p className="text-ui-base leading-6 text-foreground-subtle">
        {intl.formatMessage({ id: "settings.instructions.description" })}
      </p>
      <InstructionScopeCard
        scope="user"
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        instructionsService={instructionsService}
        rpcReady={resolution.rpcReady}
        isRemoteWorkspace={resolution.isRemoteTarget}
      />
      <InstructionScopeCard
        scope="workspace"
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        instructionsService={instructionsService}
        rpcReady={resolution.rpcReady}
        isRemoteWorkspace={resolution.isRemoteTarget}
      />
    </div>
  );
}
