import { TaskGroupRepository } from "#src/task-groups/index.js";
import {
  isTasksStorageMigrated,
  isTasksStoragePrepared,
} from "#src/session/tasksDatabase/prepared.js";
/* eslint-disable max-lines -- task 索引仓库集中维护 sqlite schema、查询和状态写入，迁移稳定后再按读写职责拆分。 */
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  isRemoteWorkspaceIdentity,
  normalizeAgentProviderToZCodeAgent,
  zcodeTaskMetaSchema,
  resolveWorkspaceKey,
  type ZCodeProvider,
  type ZCodeTaskMeta,
} from "@zcode/shared";
import { matchesTaskListMembershipKind } from "@zcode/shared/zcode-protocol-v4";
import type {
  ZCodeTaskListQuery,
  ZCodeTaskListResult,
  ZCodeTaskListItem,
} from "#src/session/zcodeTaskListTypes.js";

import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { getTasksIndexDatabasePath, getZCodeDataRootDir } from "#src/paths.js";
import { projectStorage, type ProjectMigrationContext } from "#src/project-storage/index.js";
import { runTasksDatabaseMigrations } from "#src/session/tasksDatabase/migrations.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

function appendZCodeAgentIndexedProviderFilter(
  where: string[],
  args: Array<string | number>,
  provider: ZCodeProvider,
): void {
  // Bugfix: ZCode Agent 列表入口只展示当前 glm runtime 产生的 task。
  // 旧 Claude Code 导入也不再例外，否则非 glm 历史数据仍会混入项目树与任务区。
  where.push("provider = ?");
  args.push(provider);
}
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;
type SQLInputValue = import("node:sqlite").SQLInputValue;

interface TaskIndexRow {
  cli_title?: string | null;
  cli_title_source?: string | null;
  cli_created_at?: number | null;
  cli_updated_at?: number | null;
  cli_last_outcome?: "completed" | "interrupted" | "error" | null;
  cli_deleted?: number | null;
  handoff_pending?: number;

  workspace_key: string;
  workspace_path: string;
  workspace_identity: string | null;
  task_id: string;
  title: string;
  task_status: string | null;
  provider: string | null;
  mode: string;
  model: string | null;
  migration_source: string | null;
  forked_from_task_id: string | null;
  cron_automation_id: string | null;
  off_peak_task_id: string | null;
  created_at: number;
  updated_at: number;
  unread_at: number | null;
  last_unread_at: number;
  pinned: number;
  archived: number;
  deleted: number;
  title_overridden: number;
  searchable_text: string;
  meta_json: string;
}

interface LegacyAcpTaskIndexRow extends TaskIndexRow {
  acp_session_id: string | null;
}

interface TaskIndexWriteRecord {
  meta: ZCodeTaskMeta;
  pinned: boolean;
  archived: boolean;
  deleted: boolean;
  titleOverridden: boolean;
  /**
   * 默认不写 unread_at：普通写入只落 CLI 事实，未读由 CAS 端口单独维护。
   * 只有「整批清未读」需要把 `unreadAt: undefined` 通过 upsert 落到列上，
   * 同时保留 last_unread_at 水位（否则旧客户端拿旧版本号会清掉之后的未读）。
   */
  writeUnreadAt?: boolean;
}

interface TaskIndexStatePatch {
  pinned?: boolean;
  archived?: boolean;
  unreadAt?: number;
}

// 关键业务逻辑：聊天内容搜索只需要可匹配文本，不需要把完整超长会话无限塞进 sqlite 索引。
// 这里做上限截断，避免长任务把 tasks-index.sqlite 放大到影响启动和列表查询。
const TASK_SEARCH_SNIPPET_PREFIX_RADIUS = 20;
const TASK_SEARCH_SNIPPET_SUFFIX_RADIUS = 72;
const TASK_SEARCH_SNIPPET_MAX_CHARS = 140;
const TASK_SEARCH_SNIPPET_LIMIT = 4;
const logger = createServiceLogger("task-index-repo");

function workspaceKey(params: { workspacePath: string; workspaceIdentity?: string }): string {
  return resolveWorkspaceKey(params);
}

function resolveTaskIndexRowWorkspaceIdentity(row: TaskIndexRow): string | undefined {
  const columnIdentity = row.workspace_identity?.trim();
  if (columnIdentity === row.workspace_key) {
    return columnIdentity;
  }
  // workspace_key 是 SQLite 查询与主键隔离的真实依据；只要它是统一格式的远端 identity，
  // 返回值就必须与它一致，不能让残留的 workspace_identity 列把实体投影到另一个远端。
  if (isRemoteWorkspaceIdentity(row.workspace_key)) {
    return row.workspace_key;
  }
  // identity 投影与主键不一致时不能采用，也不能把远端实体退回 workspacePath，
  // 否则相同路径的不同远端会在侧栏 activity join 时串行。
  return undefined;
}

function rowToMeta(row: TaskIndexRow): ZCodeTaskMeta {
  const meta = readPresentation(row);
  return {
    ...meta,
    title: row.title_overridden === 1 ? row.title : (row.cli_title ?? ""),
    titleOverridden: row.title_overridden === 1 || row.cli_title_source === "custom",
    createdAt: row.cli_created_at ?? 0,
    updatedAt: row.cli_updated_at ?? 0,
    status:
      row.cli_last_outcome === "interrupted" ? "completed" : (row.cli_last_outcome ?? undefined),
  };
}

function readPresentation(row: TaskIndexRow): ZCodeTaskMeta {
  const workspaceIdentity = resolveTaskIndexRowWorkspaceIdentity(row);
  try {
    const parsed = zcodeTaskMetaSchema.safeParse(JSON.parse(row.meta_json));
    if (parsed.success) {
      return {
        ...(parsed.data as ZCodeTaskMeta),
        // SQLite 使用这些字段查询并隔离实体，旧 meta_json 里的 identity
        // 可能缺失或属于旧远端。读取时必须与行主键投影一致，sessions-index 才能
        // 按 workspaceKey + taskId 附加 running activity。
        taskId: row.task_id,
        workspacePath: row.workspace_path,
        workspaceIdentity,
        // unread 是 tasks-index 产品壳状态；标量列必须覆盖可能来自其他 Host 的旧 meta_json。
        unreadAt: row.unread_at ?? undefined,
        // cron 身份以 meta_json 为准；cron_automation_id 列是索引投影，仅作兜底：
        // 历史行 meta_json 里可能还没有该字段，回退读列，下次写入会自动回填进 meta_json。
        cronAutomationId: parsed.data.cronAutomationId ?? row.cron_automation_id ?? undefined,
        // off-peak 身份同款策略：meta_json 为准、列兜底——存量迁移只写列即可生效。
        offPeakTaskId: parsed.data.offPeakTaskId ?? row.off_peak_task_id ?? undefined,
        titleOverridden: row.title_overridden === 1,
      };
    }
    logger.warn(
      undefined,
      `读取 task index meta_json 非法 taskId=${row.task_id}`,
      parsed.error.flatten(),
    );
  } catch (error) {
    logger.warn(undefined, `读取 task index meta_json 失败 taskId=${row.task_id}`, error);
  }

  return {
    taskId: row.task_id,
    traceId: `zcode-${row.task_id}`,
    title: "",
    titleOverridden: row.title_overridden === 1,
    workspacePath: row.workspace_path,
    workspaceIdentity,
    createdAt: 0,
    updatedAt: 0,
    mode: row.mode as ZCodeTaskMeta["mode"],
    model: row.model ?? undefined,
    // 旧行 provider 列可能残留三方 CLI 值；meta 回退投影时统一归一为 glm。
    provider: row.provider
      ? normalizeAgentProviderToZCodeAgent(row.provider as ZCodeTaskMeta["provider"])
      : undefined,
    migrationSource: (row.migration_source as ZCodeTaskMeta["migrationSource"]) ?? undefined,
    forkedFromTaskId: row.forked_from_task_id ?? undefined,
    cronAutomationId: row.cron_automation_id ?? undefined,
    offPeakTaskId: row.off_peak_task_id ?? undefined,
    unreadAt: row.unread_at ?? undefined,
  };
}

/** 序列化 meta 到 meta_json。cron 身份随 meta 一起写入（单一来源），另在 writeRecord 投影到 cron_automation_id 索引列。 */
function serializeMetaJson(meta: ZCodeTaskMeta): string {
  return JSON.stringify(meta);
}

function normalizeLimit(limit: number | undefined): number | null {
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0
    ? Math.floor(limit)
    : null;
}

function normalizeWorkspaceKeys(
  scopes: Array<{ workspacePath: string; workspaceIdentity?: string }>,
): string[] {
  return [
    ...new Set(scopes.map((scope) => workspaceKey(scope)).filter((key) => key.trim().length > 0)),
  ].sort((left, right) => left.localeCompare(right));
}

function normalizeSearchSnippetText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, TASK_SEARCH_SNIPPET_MAX_CHARS);
}

// 全局会话搜索 (TaskSearchDialog) 期望命中正文时返回若干片段做摘要展示。
// 以匹配点为中心截窗，去重相近窗口，最多 4 条；
// 全部未命中（title 命中）时回退一条整段摘要，避免下方空白。
function buildSearchSnippets(searchableText: string, search: string | null): string[] {
  if (!search || !searchableText.trim()) {
    return [];
  }

  const normalizedSearch = search.toLocaleLowerCase();
  const normalizedText = searchableText.toLocaleLowerCase();
  const snippets: string[] = [];
  const snippetRanges: Array<{ start: number; end: number }> = [];
  let searchStart = 0;

  while (snippets.length < TASK_SEARCH_SNIPPET_LIMIT && searchStart < normalizedText.length) {
    const matchIndex = normalizedText.indexOf(normalizedSearch, searchStart);
    if (matchIndex < 0) {
      break;
    }

    const start = Math.max(0, matchIndex - TASK_SEARCH_SNIPPET_PREFIX_RADIUS);
    const end = Math.min(
      searchableText.length,
      matchIndex + normalizedSearch.length + TASK_SEARCH_SNIPPET_SUFFIX_RADIUS,
    );
    const prefix = start > 0 ? "..." : "";
    const suffix = end < searchableText.length ? "..." : "";
    const snippet = normalizeSearchSnippetText(
      `${prefix}${searchableText.slice(start, end)}${suffix}`,
    );
    const overlapsExistingSnippet = snippetRanges.some(
      (range) => Math.min(range.end, end) - Math.max(range.start, start) > 0,
    );
    // 同一个关键词在很近的位置多次出现时，摘要窗口会高度重叠；服务端先合并近重复摘要。
    if (snippet && !overlapsExistingSnippet) {
      snippets.push(snippet);
      snippetRanges.push({ start, end });
    }
    searchStart = matchIndex + normalizedSearch.length;
  }

  if (snippets.length === 0) {
    // title 命中但正文没命中时，仍给一条整段摘要兜底，避免标题下方空白。
    const fallbackSnippet = normalizeSearchSnippetText(searchableText);
    return fallbackSnippet ? [fallbackSnippet] : [];
  }

  return snippets;
}

function rowToTaskListItem(row: TaskIndexRow, search: string | null): ZCodeTaskListItem {
  const meta = rowToMeta(row);
  // 修复原因：全局任务搜索之前只匹配 title/searchable_text，用户按会话 ID（sess_xxx，即 task_id）
  // 定位会话时搜不到。现在 queryTaskList 已把 LOWER(task_id) 纳入 LIKE 匹配；这里在 task_id 命中时
  // 直接用会话 ID 作为摘要——此时正文摘要是无关 fallback，展示 ID 才能让用户确认命中原因并在 UI 高亮。
  if (search && row.task_id.toLocaleLowerCase().includes(search.toLocaleLowerCase())) {
    return { ...meta, searchSnippet: row.task_id, searchSnippets: [row.task_id] };
  }
  const snippets = buildSearchSnippets(row.searchable_text, search);
  if (snippets.length === 0) {
    return meta;
  }
  return { ...meta, searchSnippet: snippets[0], searchSnippets: snippets };
}

function migrateLegacyTaskMetaJson(
  rawMetaJson: string,
  fallback: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    mode: string;
    provider?: string;
    model?: string;
    status?: ZCodeTaskMeta["status"];
  },
): ZCodeTaskMeta {
  let parsed: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(rawMetaJson) as unknown;
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      parsed = raw as Record<string, unknown>;
    }
  } catch {
    parsed = {};
  }
  const meta = {
    ...parsed,
    taskId: fallback.taskId,
    traceId:
      typeof parsed.traceId === "string" && parsed.traceId
        ? parsed.traceId
        : `zcode-${fallback.taskId}`,
    title: fallback.title,
    workspacePath: fallback.workspacePath,
    workspaceIdentity: fallback.workspaceIdentity,
    createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : fallback.createdAt,
    updatedAt: fallback.updatedAt,
    mode: typeof parsed.mode === "string" ? parsed.mode : fallback.mode,
    provider: typeof parsed.provider === "string" ? parsed.provider : fallback.provider,
    model: typeof parsed.model === "string" ? parsed.model : fallback.model,
    status: typeof parsed.status === "string" ? parsed.status : fallback.status,
    migrationSource: undefined,
  };
  return zcodeTaskMetaSchema.parse(meta) as ZCodeTaskMeta;
}

export class TaskIndexRepo {
  /** 启动迁移结果，供 main 提示；不参与任务事实或组织状态。 */
  migrationBackupSkipped = false;
  private db: DatabaseSyncInstance | null = null;
  private dbPath: string | null = null;
  private initializePromise: Promise<void> | null = null;
  private readonly writeChains = new Map<string, Promise<void>>();

  constructor(
    private readonly migrationSettings?: ProjectMigrationContext["settings"],
    private readonly storageHostId?: string,
    private readonly startupDbPath?: string,
    private readonly startupBusyTimeoutMs = 5000,
  ) {}

  /** Host 装配层共用迁移后的组织库；UI 只能通过 project/remote-projects 服务访问。 */
  private admitTaskGroup(meta: ZCodeTaskMeta, archived: boolean, deleted: boolean) {
    if (this.storageHostId && this.storageHostId !== "local") return;
    // 本机只登记本机事实；远程成员由控制端服务验证远端投影后写入。
    if (meta.workspaceIdentity?.trim()) return;
    new TaskGroupRepository(this.getDatabase()).admit([
      { ...meta, hostId: "local", archived, deleted },
    ]);
  }

  async getOrganizationDatabase() {
    await this.ensureReady();
    return this.getDatabase();
  }

  async getProjectRepository() {
    await this.ensureReady();
    return projectStorage.repository(this.getDatabase(), this.storageHostId);
  }

  async ensureReady(): Promise<void> {
    const path = this.startupDbPath ?? getTasksIndexDatabasePath();
    if (this.dbPath && this.dbPath !== path) {
      this.close();
    }
    if (!this.initializePromise) {
      this.initializePromise = this.initialize(path).catch((error) => {
        // 释放失败连接；迁移后修复可能已部分提交，重试仍走原幂等初始化。
        this.close();
        throw error;
      });
    }
    await this.initializePromise;
  }

  close(options?: { throwOnError?: boolean }): void {
    let closeError: unknown;
    try {
      this.db?.close();
    } catch (error) {
      closeError = error;
      // ignore close errors
    }
    this.db = null;
    this.dbPath = null;
    this.initializePromise = null;
    this.writeChains.clear();
    if (options?.throwOnError && closeError) throw closeError;
  }

  private async initialize(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    if (!this.db) {
      this.db = new DatabaseSync(path);
      this.dbPath = path;
      // 多窗口 Host 共用 tasks-index；写事务和首次 schema 升级应短暂等待，而不是立即 SQLITE_BUSY。
      this.db.exec(`PRAGMA busy_timeout = ${this.startupBusyTimeoutMs}`);
      this.db.exec("PRAGMA foreign_keys = ON");
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
    }
    const taskMigration = await runTasksDatabaseMigrations(this.db, path);
    const migration = await projectStorage.migrate(this.getDatabase(), {
      settings: this.migrationSettings,
      hostId: this.storageHostId,
      backupDirectories: [join(getZCodeDataRootDir(), "backup")],
      warn: (message, details) => createServiceLogger("project-migration").warn(message, details),
    });
    this.migrationBackupSkipped = taskMigration.backupSkipped || migration.backupSkipped;
    this.backfillOffPeakTaskMarkers();
    // Bugfix: z-code-2 早期列表 task_id 是 wrapper id，真实 ZCode session id 在旧列
    // acp_session_id。直接运行时映射会让 read/send/subscribe 到处变成双 ID 兜底；
    // 初始化时把索引行迁到真实 session id，后续统一走新协议正常路径。
    this.migrateLegacyAcpTaskIds();
  }

  private hasColumn(table: string, column: string): boolean {
    const columns = this.getDatabase().prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    return columns.some((item) => item.name === column);
  }

  /**
   * 存量回填（幂等，每次 bootstrap 自愈）：打点上线前产生的 off-peak 会话行没有
   * offPeakTaskId。off_peak_tasks 与 tasks 同库（tasks-index.sqlite），按 session 绑定
   * join 只补投影列——rowToMeta 以列兜底即可生效，下次展示更新会回填 meta_json。
   * 全新安装时 off_peak_tasks 可能尚未由 OffPeakTaskRepo 建表，需 guard。
   */
  private backfillOffPeakTaskMarkers(): void {
    const database = this.getDatabase();
    const hasOffPeakTable = database
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'off_peak_tasks'`)
      .get();
    if (!hasOffPeakTable) {
      return;
    }
    database
      .prepare(
        `UPDATE tasks SET off_peak_task_id = (
          SELECT o.off_peak_task_id FROM off_peak_tasks o
          WHERE o.session_id = tasks.task_id AND o.workspace_key = tasks.workspace_key
        )
        WHERE off_peak_task_id IS NULL
          AND EXISTS (
            SELECT 1 FROM off_peak_tasks o
            WHERE o.session_id = tasks.task_id AND o.workspace_key = tasks.workspace_key
          )`,
      )
      .run();
  }

  private migrateLegacyAcpTaskIds(): void {
    if (!this.hasColumn("tasks", "acp_session_id")) {
      return;
    }

    const db = this.getDatabase();
    const rows = db
      .prepare(
        `SELECT
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          acp_session_id,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          last_unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json, cli_title, cli_title_source, cli_created_at, cli_updated_at, cli_last_outcome, cli_deleted, handoff_pending
        FROM tasks
        WHERE acp_session_id IS NOT NULL
          AND trim(acp_session_id) <> ''
          AND trim(acp_session_id) <> task_id`,
      )
      .all() as unknown as LegacyAcpTaskIndexRow[];
    if (rows.length === 0) {
      return;
    }

    const findTarget = db.prepare(
      `SELECT
        workspace_key,
        workspace_path,
        workspace_identity,
        task_id,
        title,
        task_status,
        provider,
        mode,
        model,
        migration_source,
        forked_from_task_id,
        created_at,
        updated_at,
        unread_at,
        last_unread_at,
        pinned,
        archived,
        deleted,
        title_overridden,
        searchable_text,
        meta_json, cli_title, cli_title_source, cli_created_at, cli_updated_at, cli_last_outcome, cli_deleted, handoff_pending
      FROM tasks
      WHERE workspace_key = ? AND task_id = ?`,
    );
    const updateRow = db.prepare(
      `UPDATE tasks
      SET task_id = @task_id,
        title = @title,
        task_status = @task_status,
        provider = @provider,
        mode = @mode,
        model = @model,
        migration_source = @migration_source,
        forked_from_task_id = @forked_from_task_id,
        created_at = @created_at,
        updated_at = @updated_at,
        unread_at = @unread_at,
        last_unread_at = @last_unread_at,
        pinned = @pinned,
        archived = @archived,
        deleted = @deleted,
        title_overridden = @title_overridden,
        searchable_text = @searchable_text,
        meta_json = @meta_json,
        acp_session_id = NULL
      WHERE workspace_key = @workspace_key AND task_id = @old_task_id`,
    );
    const updateTarget = db.prepare(
      `UPDATE tasks
      SET title = @title,
        task_status = @task_status,
        provider = @provider,
        mode = @mode,
        model = @model,
        migration_source = @migration_source,
        forked_from_task_id = @forked_from_task_id,
        created_at = @created_at,
        updated_at = @updated_at,
        unread_at = @unread_at,
        last_unread_at = @last_unread_at,
        pinned = @pinned,
        archived = @archived,
        deleted = @deleted,
        title_overridden = @title_overridden,
        searchable_text = @searchable_text,
        meta_json = @meta_json
      WHERE workspace_key = @workspace_key AND task_id = @task_id`,
    );
    const deleteOld = db.prepare(`DELETE FROM tasks WHERE workspace_key = ? AND task_id = ?`);

    db.exec("BEGIN IMMEDIATE");
    try {
      let migrated = 0;
      for (const row of rows) {
        const nextTaskId = row.acp_session_id?.trim();
        if (!nextTaskId) {
          continue;
        }
        const target = findTarget.get(row.workspace_key, nextTaskId) as TaskIndexRow | undefined;
        const merged = this.buildLegacyAcpMigratedRow(row, target ?? null, nextTaskId);
        if (target) {
          updateTarget.run(merged);
          deleteOld.run(row.workspace_key, row.task_id);
        } else {
          updateRow.run({ ...merged, old_task_id: row.task_id });
        }
        migrated += 1;
      }
      db.exec("COMMIT");
      if (migrated > 0) {
        logger.info(undefined, `已迁移 legacy ACP task_id 到 ZCode session id 数量=${migrated}`);
      }
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  private buildLegacyAcpMigratedRow(
    source: LegacyAcpTaskIndexRow,
    target: TaskIndexRow | null,
    taskId: string,
  ): Record<string, SQLInputValue> {
    const sourceMeta = migrateLegacyTaskMetaJson(source.meta_json, {
      taskId,
      workspacePath: source.workspace_path,
      workspaceIdentity: source.workspace_identity ?? undefined,
      title: source.title,
      createdAt: source.created_at,
      updatedAt: source.updated_at,
      mode: source.mode,
      provider: source.provider ?? undefined,
      model: source.model ?? undefined,
      status: source.task_status ? (source.task_status as ZCodeTaskMeta["status"]) : undefined,
    });
    if (!target) {
      return {
        workspace_key: source.workspace_key,
        task_id: taskId,
        title: source.title,
        task_status: source.task_status,
        provider: source.provider,
        mode: source.mode,
        model: source.model,
        migration_source: null,
        forked_from_task_id: source.forked_from_task_id,
        created_at: source.created_at,
        updated_at: source.updated_at,
        unread_at: source.unread_at,
        last_unread_at: Math.max(source.last_unread_at, source.unread_at ?? 0),
        pinned: source.pinned,
        archived: source.archived,
        deleted: source.deleted,
        title_overridden: source.title_overridden,
        searchable_text: source.searchable_text,
        meta_json: JSON.stringify(sourceMeta),
      };
    }

    const targetMeta = migrateLegacyTaskMetaJson(target.meta_json, {
      ...sourceMeta,
      taskId,
      workspacePath: target.workspace_path,
      workspaceIdentity: target.workspace_identity ?? undefined,
      title: target.title || source.title,
      createdAt: Math.min(target.created_at, source.created_at),
      updatedAt: Math.max(target.updated_at, source.updated_at),
      mode: target.mode || source.mode,
      provider: target.provider ?? source.provider ?? undefined,
      model: target.model ?? source.model ?? undefined,
      status: target.task_status
        ? (target.task_status as ZCodeTaskMeta["status"])
        : source.task_status
          ? (source.task_status as ZCodeTaskMeta["status"])
          : undefined,
    });
    const title = source.title_overridden === 1 ? source.title : target.title || source.title;
    const updatedAt = Math.max(target.updated_at, source.updated_at);
    const unreadAt =
      source.unread_at !== null && target.unread_at !== null
        ? Math.max(source.unread_at, target.unread_at)
        : (source.unread_at ?? target.unread_at);
    return {
      workspace_key: source.workspace_key,
      task_id: taskId,
      title,
      task_status: target.task_status ?? source.task_status,
      provider: target.provider ?? source.provider,
      mode: target.mode || source.mode,
      model: target.model ?? source.model,
      migration_source: null,
      forked_from_task_id: target.forked_from_task_id ?? source.forked_from_task_id,
      created_at: Math.min(target.created_at, source.created_at),
      updated_at: updatedAt,
      unread_at: unreadAt,
      last_unread_at: Math.max(source.last_unread_at, target.last_unread_at, unreadAt ?? 0),
      pinned: source.pinned === 1 || target.pinned === 1 ? 1 : 0,
      archived: source.archived === 1 || target.archived === 1 ? 1 : 0,
      deleted: source.deleted === 1 ? 1 : target.deleted,
      title_overridden: source.title_overridden === 1 || target.title_overridden === 1 ? 1 : 0,
      searchable_text: target.searchable_text || source.searchable_text,
      meta_json: JSON.stringify({
        ...targetMeta,
        title,
        updatedAt,
        unreadAt: unreadAt ?? undefined,
        migrationSource: undefined,
      }),
    };
  }

  private getDatabase(): DatabaseSyncInstance {
    if (!this.db) {
      throw new Error("task index sqlite 尚未初始化");
    }
    return this.db;
  }

  private writeKey(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): string {
    return `${workspaceKey(params)}\u0000${params.taskId}`;
  }

  private enqueueWrite<T>(
    params: { workspacePath: string; workspaceIdentity?: string; taskId: string },
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const key = this.writeKey(params);
    const previous = this.writeChains.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const completion = result.then(
      () => undefined,
      () => undefined,
    );
    this.writeChains.set(key, completion);
    void completion.finally(() => {
      if (this.writeChains.get(key) === completion) {
        this.writeChains.delete(key);
      }
    });
    return result;
  }

  private getTaskRow(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): TaskIndexRow | null {
    const row = this.getDatabase()
      .prepare(
        `SELECT
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          last_unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json, cli_title, cli_title_source, cli_created_at, cli_updated_at, cli_last_outcome, cli_deleted, handoff_pending
        FROM tasks
        WHERE workspace_key = ? AND task_id = ?`,
      )
      .get(workspaceKey(params), params.taskId) as TaskIndexRow | undefined;
    return row ?? null;
  }

  private writeRecord(record: TaskIndexWriteRecord): ZCodeTaskMeta {
    const database = this.getDatabase();
    const ownTransaction = !database.isTransaction;
    if (ownTransaction) database.exec("BEGIN IMMEDIATE");
    try {
      // 本方法只在预留行首次落 CLI 事实时调用，正文索引与未读 CAS marker 都不归它写：
      // 读一次现有行，ON CONFLICT 时原样保留 searchable_text / unread_at。
      const existing = this.getTaskRow({
        workspacePath: record.meta.workspacePath,
        workspaceIdentity: record.meta.workspaceIdentity,
        taskId: record.meta.taskId,
      });
      const searchableText = existing?.searchable_text ?? "";
      this.getDatabase()
        .prepare(
          `INSERT INTO tasks (
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          last_unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json
        ) VALUES (
          @workspace_key,
          @workspace_path,
          @workspace_identity,
          @task_id,
          @title,
          @task_status,
          @provider,
          @mode,
          @model,
          @migration_source,
          @forked_from_task_id,
          @cron_automation_id,
          @off_peak_task_id,
          @created_at,
          @updated_at,
          @unread_at,
          @last_unread_at,
          @pinned,
          @archived,
          @deleted,
          @title_overridden,
          @searchable_text,
          @meta_json
        )
        ON CONFLICT(workspace_key, task_id) DO UPDATE SET
          workspace_path = excluded.workspace_path,
          workspace_identity = excluded.workspace_identity,
          title = excluded.title,
          task_status = excluded.task_status,
          provider = excluded.provider,
          mode = excluded.mode,
          model = excluded.model,
          migration_source = excluded.migration_source,
          forked_from_task_id = excluded.forked_from_task_id,
          cron_automation_id = excluded.cron_automation_id,
          off_peak_task_id = excluded.off_peak_task_id,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          unread_at = CASE WHEN @write_unread_at = 1 THEN excluded.unread_at ELSE tasks.unread_at END,
          last_unread_at = CASE
            WHEN @write_unread_at = 1 THEN MAX(tasks.last_unread_at, COALESCE(excluded.unread_at, 0))
            ELSE MAX(tasks.last_unread_at, COALESCE(tasks.unread_at, 0))
          END,
          pinned = excluded.pinned,
          archived = excluded.archived,
          deleted = excluded.deleted,
          title_overridden = excluded.title_overridden,
          searchable_text = excluded.searchable_text,
          meta_json = excluded.meta_json`,
        )
        .run({
          workspace_key: workspaceKey(record.meta),
          workspace_path: record.meta.workspacePath,
          workspace_identity: record.meta.workspaceIdentity ?? null,
          task_id: record.meta.taskId,
          title: record.meta.title,
          task_status: record.meta.status ?? null,
          provider: record.meta.provider ?? null,
          mode: record.meta.mode,
          model: record.meta.model ?? null,
          migration_source: record.meta.migrationSource ?? null,
          forked_from_task_id: record.meta.forkedFromTaskId ?? null,
          // cron automation 身份从 meta 投影到索引列（meta_json 里也保留一份，见 serializeMetaJson）。
          cron_automation_id: record.meta.cronAutomationId ?? null,
          // off-peak 身份（D48）同款投影。
          off_peak_task_id: record.meta.offPeakTaskId ?? null,
          created_at: record.meta.createdAt,
          updated_at: record.meta.updatedAt,
          unread_at: record.meta.unreadAt ?? null,
          last_unread_at: record.meta.unreadAt ?? 0,
          write_unread_at: record.writeUnreadAt ? 1 : 0,
          pinned: record.pinned ? 1 : 0,
          archived: record.archived ? 1 : 0,
          deleted: record.deleted ? 1 : 0,
          title_overridden: record.titleOverridden ? 1 : 0,
          searchable_text: searchableText,
          meta_json: serializeMetaJson(record.meta),
        });
      projectStorage.admitTaskIdentity(database, record.meta, this.storageHostId);
      if (record.titleOverridden)
        database
          .prepare(
            "UPDATE tasks SET handoff_pending=handoff_pending | 2 WHERE workspace_key=? AND task_id=? AND cli_title_source IS NULL",
          )
          .run(workspaceKey(record.meta), record.meta.taskId);

      const persisted = this.getTaskRow(record.meta);
      if (!persisted) {
        throw new Error(`task index 写入后缺少 task: ${record.meta.taskId}`);
      }
      this.admitTaskGroup(rowToMeta(persisted), persisted.archived === 1, persisted.deleted === 1);
      if (ownTransaction) database.exec("COMMIT");
      return rowToMeta(persisted);
    } catch (error) {
      if (ownTransaction && database.isTransaction) database.exec("ROLLBACK");
      throw error;
    }
  }

  async listReconciliationRows(target: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<Array<{ meta: ZCodeTaskMeta; handoffPending: number }>> {
    await this.ensureReady();
    const rows = this.getDatabase()
      .prepare("SELECT * FROM tasks WHERE workspace_key=?")
      .all(workspaceKey(target)) as unknown as TaskIndexRow[];
    return rows.map((row) => ({ meta: rowToMeta(row), handoffPending: row.handoff_pending ?? 0 }));
  }

  /** CLI 确认 child 后移除旧版本误建的派生行，不修改会话正文或 CLI deleted。 */
  async removeSubagentIndexRow(target: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): Promise<void> {
    await this.ensureReady();
    return this.enqueueWrite(target, () => {
      this.getDatabase()
        .prepare("DELETE FROM tasks WHERE workspace_key=? AND task_id=?")
        .run(workspaceKey(target), target.taskId);
    });
  }

  async markCliOrphan(target: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): Promise<void> {
    await this.ensureReady();
    return this.enqueueWrite(target, () => {
      this.getDatabase()
        .prepare(
          "UPDATE tasks SET handoff_pending=handoff_pending | 4 WHERE workspace_key=? AND task_id=?",
        )
        .run(workspaceKey(target), target.taskId);
    });
  }

  /** 仅 syncer 消费 CLI 明确删除，不以列表缺席推断删除。 */
  async applyCliDeletion(target: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): Promise<void> {
    await this.ensureReady();
    return this.enqueueWrite(target, () => {
      const db = this.getDatabase();
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          "UPDATE tasks SET cli_deleted=1,deleted=1,handoff_pending=handoff_pending & ~1 WHERE workspace_key=? AND task_id=?",
        ).run(workspaceKey(target), target.taskId);
        const row = this.getTaskRow(target);
        if (row) this.admitTaskGroup(rowToMeta(row), row.archived === 1, true);
        db.exec("COMMIT");
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  /** 仅 syncer 调用：CLI 事实是唯一来源，组织态写者不得合成这些值。 */
  async applyCliFacts(params: {
    meta: ZCodeTaskMeta;
    titleSource?: string;
    lastOutcome?: "completed" | "interrupted" | "error";
    deleted?: boolean;
  }): Promise<ZCodeTaskMeta> {
    await this.ensureReady();
    return this.enqueueWrite(params.meta, () => {
      const db = this.getDatabase();
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = this.getTaskRow(params.meta);
        // 预留行尚无 CLI 事实。首条事实补齐 provider/展示基线，保留预留后发生的组织操作。
        if (!existing || (existing.cli_created_at == null && existing.created_at === 0))
          this.writeRecord({
            meta: {
              ...params.meta,
              ...(existing?.title_overridden === 1 ? { title: existing.title } : {}),
            },
            pinned: existing?.pinned === 1,
            archived: existing?.archived === 1,
            deleted: existing?.deleted === 1,
            titleOverridden: existing?.title_overridden === 1,
          });
        const source = params.titleSource ?? "default";
        db.prepare(`UPDATE tasks SET
          cli_title=CASE WHEN cli_title_source='custom' AND ?<>'custom' THEN cli_title ELSE ? END,
          cli_title_source=CASE WHEN cli_title_source='custom' AND ?<>'custom' THEN cli_title_source ELSE ? END,
          cli_created_at=?,cli_updated_at=max(coalesce(cli_updated_at,0),?),
          cli_last_outcome=coalesce(?,cli_last_outcome),cli_deleted=max(coalesce(cli_deleted,0),?),
          title=CASE WHEN (handoff_pending & 2)<>0 THEN title WHEN cli_title_source='custom' AND ?<>'custom' THEN cli_title ELSE ? END,
          title_overridden=CASE WHEN (handoff_pending & 2)<>0 THEN title_overridden WHEN ?='custom' OR cli_title_source='custom' THEN 1 ELSE 0 END,
          updated_at=?,created_at=?,task_status=coalesce(?,task_status),deleted=max(deleted,?),
          handoff_pending=(handoff_pending & ~4) & CASE WHEN ?=1 THEN ~1 ELSE -1 END & CASE WHEN ?=title AND ?='custom' THEN ~2 ELSE -1 END
          WHERE workspace_key=? AND task_id=?`).run(
          source,
          params.meta.title,
          source,
          source,
          params.meta.createdAt,
          params.meta.updatedAt,
          params.lastOutcome ?? null,
          params.deleted ? 1 : 0,
          source,
          params.meta.title,
          source,
          params.meta.updatedAt,
          params.meta.createdAt,
          params.lastOutcome ?? null,
          params.deleted ? 1 : 0,
          params.deleted ? 1 : 0,
          params.meta.title,
          source,
          workspaceKey(params.meta),
          params.meta.taskId,
        );
        const persisted = this.getTaskRow(params.meta)!;
        this.admitTaskGroup(
          rowToMeta(persisted),
          persisted.archived === 1,
          persisted.deleted === 1,
        );
        db.exec("COMMIT");
        return rowToMeta(persisted);
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async clearTaskUnreadIfMatches(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    expectedUnreadAt: number;
  }): Promise<{ meta: ZCodeTaskMeta; cleared: boolean }> {
    await this.ensureReady();
    return this.enqueueWrite(params, () => {
      const db = this.getDatabase();
      db.exec("BEGIN IMMEDIATE");
      try {
        // 旧库补列时 watermark 默认为 0；清除前必须吸收现存 marker，避免重启后时钟回拨复用旧值。
        const updated = db
          .prepare(
            "UPDATE tasks SET last_unread_at=max(last_unread_at,unread_at),unread_at=NULL WHERE workspace_key=? AND task_id=? AND deleted=0 AND unread_at=?",
          )
          .run(workspaceKey(params), params.taskId, params.expectedUnreadAt);
        const row = this.getTaskRow(params);
        if (!row || row.deleted === 1)
          throw new Error(`task index 中不存在 task: ${params.taskId}`);
        db.exec("COMMIT");
        return { meta: rowToMeta(row), cleared: Number(updated.changes) > 0 };
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  /**
   * 把项目行未读蓝点覆盖的那批 task 一次性标为已读（「全部标为已读」）。
   *
   * 口径必须与蓝点判定逐字一致：蓝点统计的是 task list membership 为 `timeline` 的未读
   * （由 `matchesTaskListMembershipKind` 定义），即非置顶、非归档、未删除。这里复用同一个
   * 判定函数而不是在 SQL 里重写条件——两处副本一旦漂移，就会出现「蓝点还亮着却清不掉」
   * 或「已经清干净了蓝点还在」。
   *
   * 单事务内读改写：事务期间并发产生的未读写入进不来，语义等价于「以执行时刻为准全部清除」，
   * 所以不需要逐条 expectedUnreadAt（那是给「看着旧行快照点单条」的 compare-and-clear 用的）。
   */
  async clearWorkspaceUnread(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<{ clearedTaskIds: string[] }> {
    await this.ensureReady();
    const database = this.getDatabase();
    const unreadRows = database
      .prepare(
        `SELECT
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          last_unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json
        FROM tasks
        WHERE workspace_key = ? AND unread_at IS NOT NULL AND deleted = 0`,
      )
      .all(workspaceKey(params)) as unknown as TaskIndexRow[];
    // 置顶区、归档区的未读不点亮项目行蓝点，也就不归这个入口管：只清蓝点口径内的行。
    const badgeRows = unreadRows.filter((row) =>
      matchesTaskListMembershipKind(
        { pinned: row.pinned === 1, archived: row.archived === 1 },
        "timeline",
      ),
    );
    if (badgeRows.length === 0) {
      return { clearedTaskIds: [] };
    }

    const clearedTaskIds: string[] = [];
    // 事务体必须保持同步：sqlite 是单连接的同步驱动，BEGIN 与 COMMIT 之间一旦引入 await，
    // 其它写链就会插进这个批次，破坏「一次事务清完」的原子性。
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const row of badgeRows) {
        // 走 writeRecord 而不是裸 UPDATE：unreadAt 同时投影在 unread_at 列与 meta_json 里，
        // 也要让 last_unread_at 水位按既有规则推进，否则后续 CAS 版本会互相打架。
        this.writeRecord({
          meta: { ...rowToMeta(row), unreadAt: undefined },
          pinned: row.pinned === 1,
          archived: row.archived === 1,
          deleted: false,
          titleOverridden: row.title_overridden === 1,
          writeUnreadAt: true,
        });
        clearedTaskIds.push(row.task_id);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return { clearedTaskIds };
  }

  async deleteArchivedTask(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): Promise<ZCodeTaskMeta | null> {
    await this.ensureReady();
    return this.enqueueWrite(params, () => {
      const database = this.getDatabase();
      database.exec("BEGIN IMMEDIATE");
      try {
        const row = this.getTaskRow(params);
        // 确认框可能停留期间被另一端恢复；归档检查必须与 tombstone 写入同事务，
        // 不能先读后删。已删除/不存在也跳过，避免重试从 CLI seed 后复活。
        if (!row || row.deleted === 1 || row.archived !== 1) {
          database.exec("COMMIT");
          return null;
        }
        const meta = this.writeRecord({
          meta: rowToMeta(row),
          pinned: row.pinned === 1,
          archived: true,
          deleted: true,
          titleOverridden: row.title_overridden === 1,
        });
        // 删除事实交给 CLI；持久化意图使中途断线后仍可按既有 handoff 对账完成。
        database
          .prepare(
            "UPDATE tasks SET handoff_pending=handoff_pending | 1 WHERE workspace_key=? AND task_id=?",
          )
          .run(row.workspace_key, row.task_id);
        database.exec("COMMIT");
        return meta;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async updateTaskState(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    patch: TaskIndexStatePatch;
  }): Promise<ZCodeTaskMeta> {
    await this.ensureReady();
    return this.enqueueWrite(params, () => {
      const db = this.getDatabase();
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = this.getTaskRow(params);
        if (!row || row.deleted === 1)
          throw new Error(`task index 中不存在 task: ${params.taskId}`);
        const hasUnread = "unreadAt" in params.patch;
        // marker 的 watermark 在清除后仍保留；旧手机 CAS 不能清除同毫秒内的新未读。
        const unread =
          typeof params.patch.unreadAt === "number"
            ? Math.max(params.patch.unreadAt, row.last_unread_at + 1, (row.unread_at ?? 0) + 1)
            : null;
        db.prepare(`UPDATE tasks SET pinned=coalesce(?,pinned),archived=coalesce(?,archived),
          unread_at=CASE WHEN ? THEN ? ELSE unread_at END,
          last_unread_at=max(last_unread_at,coalesce(?,0)) WHERE workspace_key=? AND task_id=?`).run(
          params.patch.pinned === undefined ? null : Number(params.patch.pinned),
          params.patch.archived === undefined ? null : Number(params.patch.archived),
          Number(hasUnread),
          unread,
          hasUnread ? unread : null,
          workspaceKey(params),
          params.taskId,
        );
        const result = rowToMeta(this.getTaskRow(params)!);
        this.admitTaskGroup(result, row.archived === 1, row.deleted === 1);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  /** 展示缓存不接受 title/time/status/deleted；CLI 事实由独立端口写入。 */
  async updateTaskPresentation(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    presentation: Partial<
      Pick<
        ZCodeTaskMeta,
        | "mode"
        | "model"
        | "thoughtLevel"
        | "lastError"
        | "target"
        | "migrationSource"
        | "cronAutomationId"
        | "offPeakTaskId"
      >
    >;
    searchableText?: string;
  }): Promise<ZCodeTaskMeta | null> {
    await this.ensureReady();
    return this.enqueueWrite(params, () => {
      const db = this.getDatabase();
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = this.getTaskRow(params);
        if (!row) {
          db.exec("COMMIT");
          return null;
        }
        const meta = { ...rowToMeta(row), ...params.presentation };
        this.getDatabase()
          .prepare(
            `UPDATE tasks SET mode=?,model=?,migration_source=?,cron_automation_id=?,off_peak_task_id=?,meta_json=?,searchable_text=coalesce(?,searchable_text) WHERE workspace_key=? AND task_id=?`,
          )
          .run(
            meta.mode,
            meta.model ?? null,
            meta.migrationSource ?? null,
            meta.cronAutomationId ?? null,
            meta.offPeakTaskId ?? null,
            serializeMetaJson(meta),
            params.searchableText ?? null,
            workspaceKey(params),
            params.taskId,
          );
        const result = rowToMeta(this.getTaskRow(params)!);
        this.admitTaskGroup(result, row.archived === 1, row.deleted === 1);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  /**
   * 按「多少天没更新」批量归档（fork 的自动归档设置）。
   * 只动 `archived`，不碰未读与置顶；归档后的分组归属要同步 admit，否则任务组会保留已归档成员。
   */
  async archiveStaleTasks(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    olderThanDays: number;
    provider?: ZCodeProvider;
  }): Promise<ZCodeTaskMeta[]> {
    await this.ensureReady();
    const normalizedDays = Math.max(1, Math.floor(params.olderThanDays));
    const cutoff = Date.now() - normalizedDays * 24 * 60 * 60 * 1000;
    const where = [
      "workspace_key = ?",
      "deleted = 0",
      "archived = 0",
      "pinned = 0",
      "unread_at IS NULL",
      "updated_at < ?",
      "task_status = 'completed'",
    ];
    const args: Array<string | number> = [workspaceKey(params), cutoff];
    if (params.provider) {
      appendZCodeAgentIndexedProviderFilter(where, args, params.provider);
    }
    const rows = this.getDatabase()
      .prepare(
        `SELECT
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          last_unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json
        FROM tasks
        WHERE ${where.join(" AND ")}
        ORDER BY updated_at DESC, created_at DESC, task_id DESC`,
      )
      .all(...args) as unknown as TaskIndexRow[];
    if (rows.length === 0) {
      return [];
    }

    const db = this.getDatabase();
    const archiveTask = db.prepare(
      `UPDATE tasks SET archived = 1 WHERE workspace_key = ? AND task_id = ?`,
    );
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        archiveTask.run(row.workspace_key, row.task_id);
        this.admitTaskGroup(rowToMeta(row), true, false);
      }
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
    return rows.map(rowToMeta);
  }

  async listTaskMetas(params: {
    workspacePath?: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
    pinned?: boolean;
    archived?: boolean;
    includeDeleted?: boolean;
  }): Promise<ZCodeTaskMeta[]> {
    await this.ensureReady();
    // listTaskMetas 支持不传 workspacePath 查询全部任务，但 workspaceKey 只接受必填路径。
    // 先把可选入参收窄成明确的 workspace target，避免类型层把全量查询和 workspace 查询混在一起。
    const targetWorkspaceKey = params.workspacePath
      ? workspaceKey({
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
        })
      : null;
    const rows = this.getDatabase()
      .prepare(
        `SELECT
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json, cli_title, cli_title_source, cli_created_at, cli_updated_at, cli_last_outcome, cli_deleted, handoff_pending
        FROM tasks
        WHERE (@workspace_key IS NULL OR workspace_key = @workspace_key)
          AND cli_created_at IS NOT NULL
          AND (@include_deleted = 1 OR (deleted = 0 AND coalesce(cli_deleted,0) = 0))
          -- Bugfix: ZCode Agent 列表只接受当前 glm provider；Claude Code 导入也属于非 glm 历史数据。
          AND (@provider IS NULL OR provider = @provider)
          AND (@pinned IS NULL OR pinned = @pinned)
          AND (@archived IS NULL OR archived = @archived)
        ORDER BY cli_updated_at DESC, cli_created_at DESC, task_id DESC`,
      )
      .all({
        workspace_key: targetWorkspaceKey,
        include_deleted: params.includeDeleted ? 1 : 0,
        provider: params.provider ?? null,
        pinned: typeof params.pinned === "boolean" ? (params.pinned ? 1 : 0) : null,
        archived: typeof params.archived === "boolean" ? (params.archived ? 1 : 0) : null,
      }) as unknown as TaskIndexRow[];
    return rows.map(rowToMeta);
  }

  /**
   * 读取 workspace 下的删除 tombstone。
   *
   * CLI session store 会继续保留会话内容；如果列表 join 只读取 active/pinned/archived，
   * deleted task 会因“不在 archived 集合”被误判成普通 task，并在冷启动后重新出现。
   */
  async listDeletedTaskIds(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
  }): Promise<string[]> {
    await this.ensureReady();
    const workspaceKeyValue = workspaceKey({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
    });
    const rows = this.getDatabase()
      .prepare(
        `SELECT task_id
        FROM tasks
        WHERE workspace_key = @workspace_key
          AND deleted = 1
          AND (@provider IS NULL OR provider = @provider)
        ORDER BY task_id`,
      )
      .all({
        workspace_key: workspaceKeyValue,
        provider: params.provider ?? null,
      }) as Array<{ task_id: string }>;
    return rows.map((row) => row.task_id);
  }

  async queryTaskList(
    params: ZCodeTaskListQuery & { provider?: ZCodeProvider },
  ): Promise<ZCodeTaskListResult> {
    await this.ensureReady();
    const workspaceKeys = normalizeWorkspaceKeys(params.workspaceScopes);
    if (workspaceKeys.length === 0) {
      return { items: [], total: 0, hasMore: false };
    }

    const search = params.search?.trim();
    const normalizedSearchLike =
      search && search.length > 0 ? `%${search.toLocaleLowerCase()}%` : null;
    const where = [
      "deleted = 0",
      "coalesce(cli_deleted,0) = 0",
      "cli_created_at IS NOT NULL",
      `workspace_key IN (${workspaceKeys.map(() => "?").join(", ")})`,
    ];
    const args: Array<string | number> = [...workspaceKeys];
    if (params.provider) {
      appendZCodeAgentIndexedProviderFilter(where, args, params.provider);
    }
    if (params.kind === "pinned") {
      where.push("pinned = 1", "archived = 0");
    } else if (params.kind === "archived") {
      where.push("archived = 1");
    } else {
      where.push("pinned = 0", "archived = 0");
    }
    if (normalizedSearchLike) {
      // 之前只按 title 模糊匹配，没有命中聊天正文；TaskSearchDialog 长期搜不到内容。
      // 现在 title / searchable_text / task_id（会话 ID，如 sess_xxx）任一命中即视为匹配：
      // 用户会直接输入会话 ID 定位任务，task_id 不匹配导致"搜 sess_xxx 搜不到"。
      // 标题沿用上游的 title_overridden 语义：用户改过标题后按展示标题匹配，否则按 CLI 标题。
      // 正文摘要在结果阶段构建；按 task_id 命中时摘要由 rowToTaskListItem 换成会话 ID 本身。
      where.push(
        "(LOWER(CASE WHEN title_overridden=1 THEN title ELSE cli_title END) LIKE ? OR LOWER(searchable_text) LIKE ? OR LOWER(task_id) LIKE ?)",
      );
    }

    if (normalizedSearchLike) {
      args.push(normalizedSearchLike, normalizedSearchLike, normalizedSearchLike);
    }
    const whereClause = where.join(" AND ");
    const totalRow = this.getDatabase()
      .prepare(`SELECT COUNT(1) AS total FROM tasks WHERE ${whereClause}`)
      .get(...args) as { total: number } | undefined;
    const total = totalRow?.total ?? 0;

    const limit = normalizeLimit(params.limit);
    const listArgs: Array<string | number> = [...args];
    if (limit !== null) {
      listArgs.push(limit);
    }
    const orderBy =
      params.sortBy === "created"
        ? "cli_created_at DESC, cli_updated_at DESC, task_id DESC"
        : "cli_updated_at DESC, cli_created_at DESC, task_id DESC";
    const rows = this.getDatabase()
      .prepare(
        `SELECT
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json, cli_title, cli_title_source, cli_created_at, cli_updated_at, cli_last_outcome, cli_deleted, handoff_pending
        FROM tasks
        WHERE ${whereClause}
        ORDER BY ${orderBy}${limit === null ? "" : " LIMIT ?"}`,
      )
      .all(...listArgs) as unknown as TaskIndexRow[];
    const workspacePurposeByKey = new Map(
      params.workspaceScopes.flatMap((scope) =>
        scope.workspacePurpose ? [[workspaceKey(scope), scope.workspacePurpose] as const] : [],
      ),
    );

    return {
      items: rows.map((row) => {
        const item = rowToTaskListItem(row, search ?? null);
        const workspacePurpose = workspacePurposeByKey.get(row.workspace_key);
        return workspacePurpose ? { ...item, workspacePurpose } : item;
      }),
      total,
      hasMore: total > rows.length,
    };
  }

  async getTaskMeta(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): Promise<ZCodeTaskMeta | null> {
    await this.ensureReady();
    const row = this.getTaskRow(params);
    if (!row || row.deleted === 1) {
      return null;
    }
    return rowToMeta(row);
  }
}
