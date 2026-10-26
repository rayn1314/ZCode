import type { RemoteConnectionOpenPreference } from "@/app-shell/types.js";
import type {
  ProjectTree,
  RemoteProjectDirectory,
  RemoteProjectEntry,
  VirtualProject,
} from "@/project-sidebar/contract.js";
import { resolveEntryProject } from "@/project-sidebar/view.js";

/** 目录比较沿用 workspace identity 同款归一，避免尾斜杠被当成另一个目录。 */
function normalizeDirectoryPath(path: string): string {
  return `/${path
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "")}`;
}

/** 入口登记的目录集合：主 root 与旧 workspace 都可能承载同一个远端路径。 */
function matchedEntryPath(entry: RemoteProjectEntry, path: string): string | undefined {
  const normalized = normalizeDirectoryPath(path);
  return [
    ...entry.roots.map((root) => root.rootPath),
    ...(entry.legacyWorkspace ? [entry.legacyWorkspace.workspacePath] : []),
  ]
    .filter((candidate): candidate is string => Boolean(candidate))
    .find((candidate) => normalizeDirectoryPath(candidate) === normalized);
}

export interface RemoteProjectEntryResolution {
  entry: RemoteProjectEntry;
  /** 入口登记的原样目录路径；偏好与 IO 仍使用它，不能用归一形态回写。 */
  rootPath: string;
  /** 入口指向的远端项目；入口失效（远端已删或读不到项目树）时缺失。 */
  project?: VirtualProject;
}

/** 入口是否登记了该目录；解析、恢复复验与 Root 复验必须共用同一判定。 */
export function entryClaimsDirectoryPath(entry: RemoteProjectEntry, path: string): boolean {
  return matchedEntryPath(entry, path) !== undefined;
}

function isLiveEntry(candidate: RemoteProjectEntryResolution): boolean {
  return Boolean(candidate.project && !candidate.project.deleted);
}

/**
 * 按目录解析项目入口的唯一入口。同一目录可能对应多条入口：远端软删项目会留下
 * 同根的僵尸入口，逐处 `.find(首个匹配)` 会先命中它，把活项目顶成 `project.not-found`
 * 或让重连误入新建项目编辑。因此这里统一「活项目优先」，其余按目录自身顺序取首条，
 * 结果唯一且确定。
 */
export function resolveRemoteProjectEntryForDirectory(input: {
  directory: RemoteProjectDirectory;
  hostId: string;
  path: string;
  /** 远端项目树；缺失时无法判定入口是否已软删，只能按目录顺序取首条。 */
  tree?: ProjectTree;
}): RemoteProjectEntryResolution | undefined {
  const candidates: RemoteProjectEntryResolution[] = [];
  for (const entry of input.directory.entries) {
    if (entry.hostId !== input.hostId) continue;
    const rootPath = matchedEntryPath(entry, input.path);
    if (rootPath === undefined) continue;
    candidates.push({
      entry,
      rootPath,
      ...(input.tree ? { project: resolveEntryProject(entry, input.tree) } : {}),
    });
  }
  return candidates.find(isLiveEntry) ?? candidates[0];
}

export type RemoteProjectDirectorySelection =
  /** 打开入口对应的活项目；`draftProjectId` 缺失表示只恢复原会话，不解析草稿归属。 */
  | { kind: "open-project"; entry: RemoteProjectEntry; draftProjectId?: string }
  /** 目标目录确实没有活项目：进入选目录/新建项目编辑。 */
  | { kind: "create-project" }
  /** 恢复意图的原入口已从本机移除。 */
  | { kind: "cancelled" }
  /** 恢复意图的原项目已不存在（已删除或读不到）。 */
  | { kind: "not-found" };

/**
 * 目录选择的唯一判据：选目录和连接完成都要落到「打开已有活项目」上，
 * 只有目录确实没有活项目时才允许进入新建项目编辑；否则用户会在已有目录上
 * 被要求重新生成一个同根项目（见 packages/ui/spec/remote-project-root-identity.md）。
 */
export function resolveRemoteProjectDirectorySelection(input: {
  directory: RemoteProjectDirectory;
  hostId: string;
  path: string;
  tree?: ProjectTree;
  /** 连接偏好里的恢复意图：只影响失败出口与草稿归属，不影响活项目优先。 */
  preference?: Pick<
    RemoteConnectionOpenPreference,
    "preferredWorkspaceTabId" | "preferredProjectEntryId"
  >;
}): RemoteProjectDirectorySelection {
  const resolution = resolveRemoteProjectEntryForDirectory(input);
  const project =
    resolution?.project && !resolution.project.deleted ? resolution.project : undefined;
  const restoreSession = Boolean(input.preference?.preferredWorkspaceTabId);
  // 目录已有活项目就打开它，不能因偏好缺失或指向残留入口就退化成新建。
  if (resolution && project)
    return {
      kind: "open-project",
      entry: resolution.entry,
      // 会话重连只恢复原选择：解析草稿归属会阻止已删除项目的历史会话重连。
      ...(restoreSession ? {} : { draftProjectId: project.id }),
    };
  // 项目已删但会话要恢复：仍回到原目录，不解析草稿归属。
  if (resolution && restoreSession) return { kind: "open-project", entry: resolution.entry };
  if (input.preference?.preferredProjectEntryId || restoreSession)
    // 入口被移除 → 取消原意图；入口还在但项目已删 → 原失败出口（回退目录浏览器）。
    return resolution ? { kind: "not-found" } : { kind: "cancelled" };
  return { kind: "create-project" };
}
