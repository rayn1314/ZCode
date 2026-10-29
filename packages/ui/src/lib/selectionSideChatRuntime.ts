import type { ConversationSelectionReference } from "@/lib/conversationSelectionReference.js";

const pendingCreations = new Map<string, Promise<string>>();
const blockedChildSessionIds = new Set<string>();
const listeners = new Set<() => void>();
type SelectionSideChatOpener = (reference?: ConversationSelectionReference) => Promise<void>;
interface SelectionSideChatOpenerEntry {
  focused: boolean;
  referenceBlocked: boolean;
  open: SelectionSideChatOpener;
}
const openers = new Map<string, Map<symbol, SelectionSideChatOpenerEntry>>();
type SelectionSideChatHistoryLoader = () => Promise<SelectionSideChatHistoryEntry[]>;
interface SelectionSideChatHistoryLoaderEntry {
  focused: boolean;
  load: SelectionSideChatHistoryLoader;
}
const historyLoaders = new Map<string, Map<symbol, SelectionSideChatHistoryLoaderEntry>>();

export function buildSelectionSideChatKey(workspaceKey: string, parentSessionId: string): string {
  return `${workspaceKey}\0${parentSessionId}`;
}

/**
 * 同一个用户手势在 command pending 期间只创建一次；完成后立即释放 parent scope，
 * 让固定入口的下一次点击可以创建新的 child，而不是退化回旧的单例绑定。
 */
export async function createSelectionSideChat(
  key: string,
  create: () => Promise<string>,
): Promise<string> {
  const current = pendingCreations.get(key);
  if (current) return current;
  const pending = create().finally(() => {
    if (pendingCreations.get(key) === pending) {
      pendingCreations.delete(key);
    }
    emitChange();
  });
  pendingCreations.set(key, pending);
  return pending;
}

export function clearSelectionSideChat(childSessionId: string): void {
  const changed = blockedChildSessionIds.delete(childSessionId);
  if (!changed) return;
  emitChange();
}

export function setSelectionSideChatBlocked(childSessionId: string, blocked: boolean): void {
  const changed = blocked
    ? !blockedChildSessionIds.has(childSessionId)
    : blockedChildSessionIds.has(childSessionId);
  if (!changed) return;
  if (blocked) blockedChildSessionIds.add(childSessionId);
  else blockedChildSessionIds.delete(childSessionId);
  emitChange();
}

export function isSelectionSideChatBlocked(childSessionId: string): boolean {
  return blockedChildSessionIds.has(childSessionId);
}

export function subscribeSelectionSideChatRuntime(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export interface SelectionSideChatHistoryEntry {
  sessionId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Side Pane 的固定入口位于会话 Provider 外，不能自己拼协议命令。
 * 由已挂载的主 SessionPane 注册创建能力，launcher 只按 workspace + parent 路由；
 * 同一父会话被多个分屏展示时优先交给 focused pane，保持命令 owner 与当前输入焦点一致。
 */
export function registerSelectionSideChatOpener(
  key: string,
  opener: SelectionSideChatOpener,
  focused: boolean,
  referenceBlocked = false,
): () => void {
  const token = Symbol(key);
  const scoped = openers.get(key) ?? new Map<symbol, SelectionSideChatOpenerEntry>();
  scoped.set(token, { focused, open: opener, referenceBlocked });
  openers.set(key, scoped);
  emitChange();

  return () => {
    const current = openers.get(key);
    current?.delete(token);
    if (current?.size === 0) openers.delete(key);
    emitChange();
  };
}

function getSelectionSideChatOpener(key: string): SelectionSideChatOpenerEntry | undefined {
  const scoped = openers.get(key);
  if (!scoped?.size) return undefined;
  const candidates = Array.from(scoped.values());
  return candidates.find((candidate) => candidate.focused) ?? candidates[0];
}

export function getSelectionSideChatOpenState(key: string): "ready" | "blocked" | "unavailable" {
  const target = getSelectionSideChatOpener(key);
  return !target ? "unavailable" : target.referenceBlocked ? "blocked" : "ready";
}

export function requestSelectionSideChatOpen(
  key: string,
  reference?: ConversationSelectionReference,
): boolean {
  const target = getSelectionSideChatOpener(key);
  if (!target || (reference && target.referenceBlocked)) return false;
  if (reference) void target.open(reference);
  else void target.open();
  return true;
}

/**
 * 与 opener 同一路由策略：历史查询由已挂载的主 SessionPane 承接（命令 owner 与 opener 一致），
 * 侧栏 launcher 只按 workspace + parent 取"当前 pane"的实现。
 */
export function registerSelectionSideChatHistoryLoader(
  key: string,
  loader: () => Promise<SelectionSideChatHistoryEntry[]>,
  focused = false,
): () => void {
  const token = Symbol(key);
  const scoped = historyLoaders.get(key) ?? new Map<symbol, SelectionSideChatHistoryLoaderEntry>();
  scoped.set(token, { focused, load: loader });
  historyLoaders.set(key, scoped);
  emitChange();

  return () => {
    const current = historyLoaders.get(key);
    current?.delete(token);
    if (current?.size === 0) historyLoaders.delete(key);
    emitChange();
  };
}

/** 无注册者（例如只有草稿会话 / pane 尚未挂载）时返回空列表，历史入口不报错。 */
export async function loadSelectionSideChatHistory(
  key: string,
): Promise<SelectionSideChatHistoryEntry[]> {
  const scoped = historyLoaders.get(key);
  if (!scoped?.size) return [];
  const candidates = Array.from(scoped.values());
  const target = candidates.find((candidate) => candidate.focused) ?? candidates[0];
  if (!target) return [];
  return target.load();
}

function emitChange(): void {
  for (const listener of listeners) listener();
}
