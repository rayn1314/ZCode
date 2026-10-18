import { FileText, FolderGit2, Loader2, Lock, RotateCcw, Save, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";
import {
  INSTRUCTION_FILE_MAX_BYTES,
  formatInstructionBytes,
  type InstructionsService,
  type InstructionScope,
} from "@/settings/instructionFiles.js";
import { useInstructionFileCard } from "@/settings/useInstructionFileCard.js";
import { InstructionConflictDialog } from "@/settings/InstructionConflictDialog.js";
import { WorkspaceEditorButtonGroup } from "@/WorkspaceEditorButtonGroup.js";

const SCOPE_ICON = { user: UserRound, workspace: FolderGit2 } as const;

/**
 * 单个作用域的指令文件卡片：头部身份 + 生效/状态信息块 + 操作行 + 内联编辑器。
 * 状态机在 useInstructionFileCard（同一份草稿语义被两张卡复用），这里只负责呈现与布局。
 */
export function InstructionScopeCard({
  scope,
  workspacePath,
  workspaceIdentity,
  instructionsService,
  rpcReady,
  isRemoteWorkspace,
}: {
  scope: InstructionScope;
  workspacePath: string;
  workspaceIdentity?: string;
  instructionsService: InstructionsService | null;
  rpcReady: boolean;
  isRemoteWorkspace: boolean;
}) {
  const { intl } = useZCodeIntl();
  const card = useInstructionFileCard({
    scope,
    workspacePath,
    workspaceIdentity,
    instructionsService,
    rpcReady,
  });
  const { snapshot } = card;
  const exists = snapshot?.exists === true;
  // 既没读到、也没读到失败，就还是「没有磁盘事实」：保持骨架，不渲染空路径。
  const showStatusSkeleton = card.loading || (snapshot === null && card.loadError === null);
  const scopeTitle = intl.formatMessage({ id: `settings.instructions.scope.${scope}.title` });
  const ScopeIcon = SCOPE_ICON[scope];
  // 远端 workspace 的指令文件在远端机器上：本地编辑器/文件管理器会指向错误的机器，不能给假入口。
  const canOpenExternalEditor =
    !isRemoteWorkspace && exists && Boolean(snapshot?.effectivePath ?? snapshot?.targetPath);

  return (
    <section className="space-y-3" data-testid={`instructions-${scope}-section`}>
      <SettingsGroupCard>
        <div className="flex items-start gap-3 px-4 py-3">
          <div
            className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-background text-foreground-subtle"
            aria-hidden="true"
          >
            <ScopeIcon className="size-4" />
          </div>
          <div className="min-w-0">
            <h3 className="flex h-7 items-center gap-1.5 text-ui-base font-medium text-foreground">
              {scopeTitle}
            </h3>
            <p className="text-ui-sm leading-5 text-foreground-subtle">
              {intl.formatMessage({ id: `settings.instructions.scope.${scope}.subtitle` })}
            </p>
            {scope === "user" && isRemoteWorkspace ? (
              // 远端 workspace 下用户级指令属于远端 host 的 home 目录，必须点明，避免用户以为改的是本机文件。
              <p className="mt-1 text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "settings.instructions.remoteWorkspaceNote" })}
              </p>
            ) : null}
          </div>
        </div>

        {showStatusSkeleton ? (
          <div
            className="space-y-2 border-t border-border px-4 py-3"
            data-testid={`instructions-${scope}-loading`}
            aria-busy="true"
            aria-label={intl.formatMessage({ id: "common.loading" })}
          >
            <div className="h-4 w-2/3 animate-pulse rounded-sm bg-surface" aria-hidden="true" />
            <div className="h-4 w-1/3 animate-pulse rounded-sm bg-surface" aria-hidden="true" />
          </div>
        ) : (
          <div className="space-y-1.5 border-t border-border bg-surface px-4 py-3">
            {card.loadError ? (
              <p className="text-ui-base text-destructive">{card.loadError}</p>
            ) : (
              <>
                <div className="flex min-w-0 items-baseline gap-2">
                  <span className="shrink-0 text-ui-base text-foreground-subtle">
                    {intl.formatMessage({ id: "settings.instructions.effectivePath" })}
                  </span>
                  <span
                    className={`min-w-0 truncate font-mono text-ui-base ${
                      exists && snapshot?.effectivePath
                        ? "text-foreground"
                        : "text-foreground-subtle"
                    }`}
                    title={snapshot?.effectivePath ?? snapshot?.targetPath}
                    data-testid={`instructions-${scope}-effective-path`}
                  >
                    {exists && snapshot?.effectivePath
                      ? snapshot.effectivePath
                      : snapshot?.exists === false
                        ? intl.formatMessage({ id: "settings.instructions.notCreated" })
                        : (snapshot?.targetPath ?? "")}
                  </span>
                </div>
                {(snapshot?.ignoredCandidates ?? []).map((candidate) => (
                  <p
                    key={candidate}
                    className="min-w-0 truncate text-ui-sm text-foreground-subtle"
                    title={candidate}
                    data-testid={`instructions-${scope}-ignored-candidate`}
                  >
                    {intl.formatMessage(
                      { id: "settings.instructions.ignoredCandidate" },
                      { path: candidate },
                    )}
                  </p>
                ))}
                {exists ? (
                  <div className="flex flex-wrap items-center gap-2 text-ui-sm text-foreground-subtle">
                    <span className="tabular-nums" data-testid={`instructions-${scope}-bytes`}>
                      {card.bytesText}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>
                      {intl.formatMessage({ id: "settings.instructions.lastModified" })}
                      {card.mtimeText ? ` ${card.mtimeText}` : ""}
                    </span>
                    {snapshot?.truncated ? (
                      // 超限是真实生效语义（Agent 只读前 100KB），必须显式告警，不能只写在文档里。
                      <span
                        className="rounded-md bg-destructive/10 px-2 py-0.5 text-ui-sm font-medium text-destructive"
                        data-testid={`instructions-${scope}-truncated`}
                      >
                        {intl.formatMessage(
                          { id: "settings.instructions.truncated" },
                          { size: formatInstructionBytes(INSTRUCTION_FILE_MAX_BYTES) },
                        )}
                      </span>
                    ) : null}
                  </div>
                ) : null}
                {snapshot?.writable === false ? (
                  <p
                    className="flex items-center gap-1.5 text-ui-sm text-foreground-subtle"
                    data-testid={`instructions-${scope}-readonly`}
                  >
                    <Lock className="size-3.5 shrink-0" aria-hidden="true" />
                    {snapshot.readonlyReason?.trim() ||
                      intl.formatMessage({ id: "settings.instructions.readonlyFallback" })}
                  </p>
                ) : null}
              </>
            )}
          </div>
        )}

        <div
          className={`flex flex-wrap items-center gap-2 border-t border-border px-4 py-3 ${
            card.interactive ? "hover:bg-hover" : ""
          }`}
        >
          <Button
            variant="default"
            size="lg"
            // 编辑态下主按钮失活：编辑器已展开，重复点击会重置草稿（草稿只在保存 / 取消时变化）。
            disabled={
              !card.interactive || card.draft !== null || (!exists && snapshot?.writable === false)
            }
            title={snapshot?.writable === false ? snapshot.readonlyReason?.trim() : undefined}
            onClick={card.startEdit}
            data-testid={`instructions-${scope}-edit`}
          >
            <FileText className="size-4" aria-hidden="true" />
            {intl.formatMessage({
              id: exists ? "settings.instructions.edit" : "settings.instructions.create",
            })}
          </Button>
          {canOpenExternalEditor ? (
            <WorkspaceEditorButtonGroup
              workspaceAbsPath={snapshot?.effectivePath ?? snapshot?.targetPath ?? ""}
              workspaceIdentity={workspaceIdentity}
            />
          ) : null}
          <Button
            variant="outline"
            size="lg"
            disabled={card.loading || card.saving}
            onClick={() => void card.reloadSnapshot()}
            data-testid={`instructions-${scope}-reload`}
          >
            <RotateCcw className="size-4" aria-hidden="true" />
            {intl.formatMessage({ id: "settings.instructions.reload" })}
          </Button>
          {card.dirty ? (
            <span className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "settings.instructions.unsaved" })}
            </span>
          ) : null}
        </div>

        {card.saveError ? (
          <div
            className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3 text-ui-base text-destructive"
            data-testid={`instructions-${scope}-save-error`}
          >
            <span className="min-w-0">{card.saveError}</span>
            <Button
              variant="link"
              size="sm"
              className="px-0"
              disabled={card.loading || card.saving}
              onClick={() => void card.reloadSnapshot()}
            >
              {intl.formatMessage({ id: "settings.instructions.reload" })}
            </Button>
          </div>
        ) : null}

        {card.draft !== null ? (
          <div className="space-y-3 border-t border-border px-4 py-3">
            <SettingsFormTextarea
              value={card.draft}
              onChange={(event) => card.setDraftValue(event.target.value)}
              spellCheck={false}
              // 只读文件保留可选中 / 可复制，但绝不伪装可写：readOnly 而非 disabled。
              readOnly={snapshot?.writable === false}
              disabled={card.loading || card.saving}
              className="min-h-[240px] w-full font-mono text-ui-base"
              aria-label={intl.formatMessage(
                { id: "settings.instructions.editorLabel" },
                { scope: scopeTitle },
              )}
              data-testid={`instructions-${scope}-editor`}
            />
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="default"
                size="lg"
                disabled={!card.canSave}
                onClick={() => void card.saveDraft()}
                data-testid={`instructions-${scope}-save`}
              >
                {card.saving ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Save className="size-4" aria-hidden="true" />
                )}
                {intl.formatMessage({ id: "settings.instructions.save" })}
              </Button>
              <Button
                variant="outline"
                size="lg"
                disabled={card.saving}
                onClick={card.cancelEdit}
                data-testid={`instructions-${scope}-cancel`}
              >
                {intl.formatMessage({ id: "settings.instructions.cancel" })}
              </Button>
            </div>
          </div>
        ) : null}
      </SettingsGroupCard>

      <InstructionConflictDialog
        open={card.conflictOpen}
        busy={card.saving}
        onOverwrite={() => void card.resolveConflictOverwrite()}
        onDiscard={() => void card.resolveConflictDiscard()}
        onCancel={card.dismissConflict}
      />
    </section>
  );
}
