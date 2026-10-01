/**
 * 导出日志包的"什么能进包"策略。
 *
 * 独立成模块是为了让这套判定可单测：exportLogs.ts 依赖 electron 与 @zcode/services/node，
 * 路径策略本身没有任何 IO 需求，不该被这些依赖绑住。
 *
 * 立场是默认拒绝。导出产物会被用户转发出去，宁可少收也不能漏收凭据。
 * 见 spec/export-log-archive-scope.md。
 */

function normalizeArchivePath(path: string): string {
  return path.replaceAll("\\", "/");
}

const RETIRED_ACP_RUNTIME_ARCHIVE_PATHS = [
  "acp-auth",
  "acp-config",
  "acp-stream-diagnostics",
  "acp-traffic-proxy",
] as const;
const HIGH_VOLUME_RUNTIME_ARCHIVE_PATHS = ["dev"] as const;
const DOCSHOT_ARCHIVE_PATH_PREFIXES = ["docshot-backup-"] as const;
const DOCSHOT_ARCHIVE_PATHS = ["docshot-assets"] as const;
const NON_LOG_STATE_ARCHIVE_PATHS = [
  "agent-config",
  "certs",
  // crashpad dump 是崩溃瞬间的进程内存快照，凭据与会话正文会随内存一并落盘。
  // 它是排障材料，但不是日志：不导出，用户要看崩溃现场应单独取本地文件。
  "crash",
  "repo",
  "sessions",
  "session-bindings",
  "checkpoints",
] as const;
const SENSITIVE_CREDENTIAL_ARCHIVE_FILE_NAMES = new Set(["credentials.json", ".credentials.json"]);
// 任务索引库在导出根顶层，不受目录型规则约束；sqlite 与其 -wal/-shm 旁路文件一并排除。
const DATABASE_ARCHIVE_FILE_SUFFIXES = [
  ".sqlite",
  ".sqlite-wal",
  ".sqlite-shm",
  ".db",
  ".db-wal",
  ".db-shm",
] as const;
const EXCLUDED_ARCHIVE_DIRECTORY_NAMES = new Set(["debug"]);

/** Glob patterns to exclude from the exported log archive. */
const ZIP_EXCLUDE_PATTERNS: string[] = [];

function escapeRegExp(path: string): string {
  return path.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globPatternToRegExp(pattern: string): RegExp {
  const normalizedPattern = normalizeArchivePath(pattern);
  return new RegExp(`^${normalizedPattern.split("*").map(escapeRegExp).join(".*")}$`);
}

const ZIP_EXCLUDE_REGEXES = ZIP_EXCLUDE_PATTERNS.map(globPatternToRegExp);

/** 路径段匹配必须卡 `/` 边界，否则 `repo-backup`、`sessions-old` 会被整目录丢掉。 */
function matchesArchivePathPrefix(relativePath: string, archivePath: string): boolean {
  return relativePath === archivePath || relativePath.startsWith(`${archivePath}/`);
}

function isRetiredAcpRuntimePath(relativePath: string): boolean {
  return RETIRED_ACP_RUNTIME_ARCHIVE_PATHS.some((archivePath) =>
    matchesArchivePathPrefix(relativePath, archivePath),
  );
}

function isHighVolumeRuntimeArchivePath(relativePath: string): boolean {
  return HIGH_VOLUME_RUNTIME_ARCHIVE_PATHS.some((archivePath) =>
    matchesArchivePathPrefix(relativePath, archivePath),
  );
}

function isDocshotArchivePath(relativePath: string): boolean {
  const firstSegment = relativePath.split("/")[0] ?? "";
  if (DOCSHOT_ARCHIVE_PATHS.includes(firstSegment as (typeof DOCSHOT_ARCHIVE_PATHS)[number])) {
    return true;
  }
  return DOCSHOT_ARCHIVE_PATH_PREFIXES.some((prefix) => firstSegment.startsWith(prefix));
}

function isNonLogStateArchivePath(relativePath: string): boolean {
  return NON_LOG_STATE_ARCHIVE_PATHS.some((archivePath) =>
    matchesArchivePathPrefix(relativePath, archivePath),
  );
}

function isSensitiveCredentialArchivePath(relativePath: string): boolean {
  const fileName = relativePath.split("/").at(-1) ?? "";
  return SENSITIVE_CREDENTIAL_ARCHIVE_FILE_NAMES.has(fileName);
}

export function isDatabaseArchivePath(relativePath: string): boolean {
  const fileName = relativePath.split("/").at(-1)?.toLowerCase() ?? "";
  return DATABASE_ARCHIVE_FILE_SUFFIXES.some((suffix) => fileName.endsWith(suffix));
}

function isExcludedDirectoryArchivePath(relativePath: string): boolean {
  return relativePath.split("/").some((segment) => EXCLUDED_ARCHIVE_DIRECTORY_NAMES.has(segment));
}

function isExcludedCachePath(relativePath: string): boolean {
  return relativePath === "Library/Caches" || relativePath.startsWith("Library/Caches/");
}

export function isExcludedRelativePath(relativePath: string): boolean {
  const normalizedRelativePath = normalizeArchivePath(relativePath);
  // 凭据存储文件不是排障日志，且不同提供商可能复用同名文件；在收集阶段按文件名跳过。
  if (isSensitiveCredentialArchivePath(normalizedRelativePath)) {
    return true;
  }
  // 任务索引库承载全部会话元数据，体积大且不是日志材料。
  if (isDatabaseArchivePath(normalizedRelativePath)) {
    return true;
  }
  // debug 目录是模型/运行时高频轨迹，不是用户要交付的日志包材料。
  if (isExcludedDirectoryArchivePath(normalizedRelativePath)) {
    return true;
  }
  if (isNonLogStateArchivePath(normalizedRelativePath)) {
    return true;
  }
  // ~/.zcode/v2/dev 保存 stdio-traffic 等高频协议流，真实机器上会累计到 GB 级。
  if (isHighVolumeRuntimeArchivePath(normalizedRelativePath)) {
    return true;
  }
  // docshot 历史备份和素材目录体积可达 GB 级，且不属于诊断日志。
  if (isDocshotArchivePath(normalizedRelativePath)) {
    return true;
  }
  // ACP runtime 目录已退役，老用户数据里仍可能残留旧代理证书私钥。
  if (isRetiredAcpRuntimePath(normalizedRelativePath)) {
    return true;
  }
  if (isExcludedCachePath(normalizedRelativePath)) {
    return true;
  }
  return ZIP_EXCLUDE_REGEXES.some((pattern) => pattern.test(normalizedRelativePath));
}

export function shouldApplyLogExportRetention(archivePath: string): boolean {
  const normalizedArchivePath = normalizeArchivePath(archivePath);
  return (
    normalizedArchivePath.startsWith("logs/") || normalizedArchivePath.startsWith(".zcode/cli/log/")
  );
}
