import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  buildInstructionTemplate,
  formatInstructionBytes,
  formatInstructionMtime,
  type InstructionFileSnapshot,
  type InstructionsService,
  type InstructionScope,
} from "@/settings/instructionFiles.js";

type WriteOutcome = "saved" | "conflict" | "failed" | "aborted";

export interface InstructionFileCardState {
  snapshot: InstructionFileSnapshot | null;
  loading: boolean;
  loadError: string | null;
  /** 草稿为 null 表示非编辑态。 */
  draft: string | null;
  saving: boolean;
  saveError: string | null;
  conflictOpen: boolean;
  /** 卡片可交互（加载完成且读取成功），用于按钮禁用与 hover 反馈。 */
  interactive: boolean;
  dirty: boolean;
  canSave: boolean;
  bytesText: string;
  mtimeText: string | null;
  startEdit: () => void;
  cancelEdit: () => void;
  setDraftValue: (value: string) => void;
  saveDraft: () => Promise<void>;
  reloadSnapshot: () => Promise<void>;
  resolveConflictOverwrite: () => Promise<void>;
  resolveConflictDiscard: () => Promise<void>;
  dismissConflict: () => void;
}

/**
 * 单个作用域的指令文件卡片状态机：读取、编辑草稿、保存、并发冲突裁决。
 *
 * 不变式：
 * - 草稿是唯一「未保存内容」载体，只由 startEdit / 编辑输入 / 取消 / 保存成功 / 冲突裁决改变；
 *   读取（含重新加载）只刷新磁盘事实（snapshot），绝不静默覆盖草稿。
 * - 冲突不是失败：判定交给服务端（expectedMtimeMs），UI 只负责让用户在
 *   「覆盖磁盘 / 放弃修改并重新加载 / 取消」之间显式选择。
 */
export function useInstructionFileCard({
  scope,
  workspacePath,
  workspaceIdentity,
  instructionsService,
  rpcReady,
}: {
  scope: InstructionScope;
  workspacePath: string;
  workspaceIdentity?: string;
  instructionsService: InstructionsService | null;
  rpcReady: boolean;
}): InstructionFileCardState {
  const { intl, locale } = useZCodeIntl();
  const [snapshot, setSnapshot] = useState<InstructionFileSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflictOpen, setConflictOpen] = useState(false);
  const requestIdRef = useRef(0);
  // 上下文令牌：workspace / 连接态 / 作用域变化时更换。写入是异步的，切换工作区后回来的
  // 结果属于上一张卡，必须丢弃而不是回写到新卡的草稿与错误行上。
  const contextTokenRef = useRef<object>({});

  const loadFailedMessage = useCallback(
    () => intl.formatMessage({ id: "settings.instructions.loadFailed" }),
    [intl],
  );

  /** silent=true 用于保存后 / 冲突后的刷新：保留当前草稿，只更新磁盘事实。 */
  const load = useCallback(
    async ({
      silent = false,
    }: { silent?: boolean } = {}): Promise<InstructionFileSnapshot | null> => {
      if (!rpcReady) {
        return null;
      }
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      if (!silent) {
        setLoading(true);
      }
      setLoadError(null);
      if (!instructionsService) {
        // 服务未注入（旧 host / 尚未联调）：按加载失败渲染，不伪造「未创建」。
        setLoadError(intl.formatMessage({ id: "settings.instructions.serviceUnavailable" }));
        setLoading(false);
        return null;
      }
      try {
        const result = await instructionsService.readInstructionFile({
          workspaceIdentity,
          workspacePath,
          scope,
        });
        if (requestIdRef.current !== requestId) {
          return null;
        }
        setSnapshot(result);
        return result;
      } catch (error) {
        if (requestIdRef.current !== requestId) {
          return null;
        }
        logger.warn("[InstructionFilesSection] 读取指令文件失败", {
          scope,
          error: error instanceof Error ? error.message : String(error),
        });
        setLoadError(loadFailedMessage());
        toast(loadFailedMessage());
        return null;
      } finally {
        if (requestIdRef.current === requestId) {
          setLoading(false);
        }
      }
    },
    [
      instructionsService,
      intl,
      loadFailedMessage,
      rpcReady,
      scope,
      workspaceIdentity,
      workspacePath,
    ],
  );

  // effect 只按「读取输入」重新拉取；load 通过 ref 调用，避免 intl 等回调身份变化触发无谓重挂载，
  // 也避免「每次 render 都重置为加载中」把卡片卡在骨架态。
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    // workspace 或连接态变化：清空上一份快照与草稿再拉取，避免把上一个 workspace 的文件当现状展示。
    contextTokenRef.current = {};
    setSnapshot(null);
    setDraft(null);
    setSaveError(null);
    setConflictOpen(false);
    setLoading(true);
    void loadRef.current();
  }, [instructionsService, rpcReady, scope, workspaceIdentity, workspacePath]);

  const reloadSnapshot = useCallback(async () => {
    await load({ silent: true });
  }, [load]);

  const writeDraft = useCallback(
    async (content: string, expectedMtimeMs: number | null): Promise<WriteOutcome> => {
      if (!instructionsService) {
        return "failed";
      }
      const token = contextTokenRef.current;
      try {
        const result = await instructionsService.writeInstructionFile({
          workspaceIdentity,
          workspacePath,
          scope,
          content,
          expectedMtimeMs,
        });
        if (contextTokenRef.current !== token) {
          return "aborted";
        }
        if (result.ok) {
          return "saved";
        }
        if (result.reason === "conflict") {
          return "conflict";
        }
        // 失败要落在卡片内可操作错误行 + toast；reason 决定文案，服务端 message 只做兜底。
        setSaveError(
          result.reason === "not-writable"
            ? intl.formatMessage({ id: "settings.instructions.notWritable" })
            : result.message?.trim() ||
                intl.formatMessage({ id: "settings.instructions.saveFailed" }),
        );
        toast(intl.formatMessage({ id: "settings.instructions.saveFailed" }));
        return "failed";
      } catch (error) {
        if (contextTokenRef.current !== token) {
          return "aborted";
        }
        logger.warn("[InstructionFilesSection] 写入指令文件失败", {
          scope,
          error: error instanceof Error ? error.message : String(error),
        });
        setSaveError(intl.formatMessage({ id: "settings.instructions.saveFailed" }));
        toast(intl.formatMessage({ id: "settings.instructions.saveFailed" }));
        return "failed";
      }
    },
    [instructionsService, intl, scope, workspaceIdentity, workspacePath],
  );

  const saveDraft = useCallback(async () => {
    if (draft === null) {
      return;
    }
    const token = contextTokenRef.current;
    setSaving(true);
    setSaveError(null);
    try {
      const outcome = await writeDraft(draft, snapshot?.mtimeMs ?? null);
      if (contextTokenRef.current !== token || outcome === "aborted") {
        return;
      }
      if (outcome === "conflict") {
        setConflictOpen(true);
        return;
      }
      if (outcome === "saved") {
        setDraft(null);
        toast(intl.formatMessage({ id: "settings.instructions.saved" }));
        await load({ silent: true });
      }
    } finally {
      setSaving(false);
    }
  }, [draft, intl, load, snapshot?.mtimeMs, writeDraft]);

  /** 「覆盖磁盘内容」：先把磁盘当前版本接受为并发基线，再用它提交草稿。 */
  const resolveConflictOverwrite = useCallback(async () => {
    setConflictOpen(false);
    if (draft === null) {
      return;
    }
    const token = contextTokenRef.current;
    setSaving(true);
    setSaveError(null);
    try {
      const current = await load({ silent: true });
      if (contextTokenRef.current !== token || !current) {
        return;
      }
      const outcome = await writeDraft(draft, current.mtimeMs);
      if (contextTokenRef.current !== token || outcome === "aborted") {
        return;
      }
      if (outcome === "conflict") {
        setConflictOpen(true);
        return;
      }
      if (outcome === "saved") {
        setDraft(null);
        toast(intl.formatMessage({ id: "settings.instructions.saved" }));
        await load({ silent: true });
      }
    } finally {
      setSaving(false);
    }
  }, [draft, intl, load, writeDraft]);

  /** 「放弃我的修改并重新加载」：真的重新拉取并用磁盘内容替换草稿；拉取失败时保留草稿不静默丢弃。 */
  const resolveConflictDiscard = useCallback(async () => {
    setConflictOpen(false);
    setSaveError(null);
    const current = await load({ silent: true });
    if (current) {
      setDraft(current.content);
    }
  }, [load]);

  const startEdit = useCallback(() => {
    setSaveError(null);
    setDraft(
      snapshot?.exists === true
        ? snapshot.content
        : // 新建态只给骨架，不预填任何猜测内容。
          buildInstructionTemplate(intl.formatMessage),
    );
  }, [intl, snapshot]);

  const cancelEdit = useCallback(() => {
    setDraft(null);
    setSaveError(null);
  }, []);

  const setDraftValue = useCallback((value: string) => {
    setDraft(value);
  }, []);

  const dismissConflict = useCallback(() => {
    setConflictOpen(false);
  }, []);

  const loadingNow = loading || !rpcReady;
  // 「能操作」= 连接就绪、读取完成、有磁盘事实且读取没失败：任何一项缺失都不允许对 null 目标动手。
  const interactive = !loadingNow && loadError === null && snapshot !== null;
  // 「内容未变化时保存禁用」：新建态的模板是真实草稿，因此新建后可直接保存创建文件。
  const canSave =
    draft !== null &&
    !saving &&
    !loadingNow &&
    snapshot?.writable !== false &&
    (snapshot === null || draft !== snapshot.content);

  return {
    snapshot,
    loading: loadingNow,
    loadError,
    draft,
    saving,
    saveError,
    conflictOpen,
    interactive,
    dirty: draft !== null && snapshot !== null && draft !== snapshot.content,
    canSave,
    bytesText: formatInstructionBytes(snapshot?.bytes ?? 0),
    mtimeText: formatInstructionMtime(snapshot?.mtimeMs ?? null, locale),
    startEdit,
    cancelEdit,
    setDraftValue,
    saveDraft,
    reloadSnapshot,
    resolveConflictOverwrite,
    resolveConflictDiscard,
    dismissConflict,
  };
}
