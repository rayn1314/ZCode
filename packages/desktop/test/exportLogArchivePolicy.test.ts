import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import {
  isDatabaseArchivePath,
  isExcludedRelativePath,
  shouldApplyLogExportRetention,
} from "../src/main/exportLogArchivePolicy.js";
import { readSourceText } from "./readSourceText.js";

// logger 在模块加载期就 mkdir 日志目录并跑一次保留清理，必须先把出口重定向到临时目录，
// 否则单测会在真实用户数据根里留下痕迹。
const testRuntimeDir = mkdtempSync(join(tmpdir(), "zcode-export-logs-test-"));
process.env.ZCODE_ENV = "test";
process.env.ZCODE_E2E_RUNTIME_LOG_DIR = join(testRuntimeDir, "logs");

const { exportLogs } = await import("../src/main/exportLogs.js");

test("crashpad dump 整棵目录不进入日志包", () => {
  assert.equal(isExcludedRelativePath("crash"), true);
  assert.equal(isExcludedRelativePath("crash/live/reports/5b2e2236.dmp"), true);
  assert.equal(isExcludedRelativePath("crash/archive/5b2e2236.dmp"), true);
  assert.equal(isExcludedRelativePath("crash/live/settings.dat"), true);
});

test("任务索引库及其旁路文件不进入日志包", () => {
  assert.equal(isExcludedRelativePath("tasks-index.sqlite"), true);
  assert.equal(isExcludedRelativePath("tasks-index.sqlite-wal"), true);
  assert.equal(isExcludedRelativePath("tasks-index.sqlite-shm"), true);
  assert.equal(isDatabaseArchivePath("nested/dir/app.db"), true);
  assert.equal(isDatabaseArchivePath("app.db-wal"), true);
  // 后缀匹配不能误伤名字里带 db/sqlite 的普通日志。
  assert.equal(isDatabaseArchivePath("logs/sqlite-errors.log"), false);
  assert.equal(isDatabaseArchivePath("logs/dbdump.txt"), false);
});

test("既有排除规则保持不变", () => {
  assert.equal(isExcludedRelativePath("credentials.json"), true);
  assert.equal(isExcludedRelativePath("agent-config/settings.json"), true);
  assert.equal(isExcludedRelativePath("debug/model-io.jsonl"), true);
  assert.equal(isExcludedRelativePath("dev/stdio-traffic.bin"), true);
  assert.equal(isExcludedRelativePath("acp-auth/cert.pem"), true);
  assert.equal(isExcludedRelativePath("Library/Caches/blob"), true);
});

test("正常日志仍然进入日志包", () => {
  assert.equal(isExcludedRelativePath("logs/2026-10-02.log"), false);
  assert.equal(isExcludedRelativePath(".zcode/cli/log/zcode-2026-10-02.jsonl"), false);
  assert.equal(isExcludedRelativePath("about.txt"), false);
});

test("目录段匹配卡 / 边界，同前缀的兄弟目录不再被误丢", () => {
  // 修复前 isNonLogStateArchivePath 用 startsWith(name)，会把这些目录整个丢掉。
  assert.equal(isExcludedRelativePath("repo"), true);
  assert.equal(isExcludedRelativePath("repo/src/index.ts"), true);
  assert.equal(isExcludedRelativePath("repo-backup/src/index.ts"), false);
  assert.equal(isExcludedRelativePath("certs2/server.key"), false);
  assert.equal(isExcludedRelativePath("sessions-old/2026/a.md"), false);
  assert.equal(isExcludedRelativePath("session-bindings/bind.json"), true);
  // 退役 Repo 功能的产物（加密快照、wiki 正文）同样按目录段排除，不是 repo 的兄弟目录。
  assert.equal(
    isExcludedRelativePath("repo-snapshots/workspace-a/pending/snapshot.tar.gz.enc"),
    true,
  );
  assert.equal(isExcludedRelativePath("repo-wiki/workspace-a/wiki.json"), true);
});

test("凭据文件名与排除目录段的判定大小写不敏感", () => {
  // Windows / macOS 文件系统大小写不敏感，CREDENTIALS.JSON 与 credentials.json 指向同一份文件；
  // 逐字符比对等于给绕开放行，而导出包会被用户转发出去——宁可少收，不能漏收凭据。
  assert.equal(isExcludedRelativePath("CREDENTIALS.JSON"), true);
  assert.equal(isExcludedRelativePath(".CREDENTIALS.JSON"), true);
  assert.equal(isExcludedRelativePath("runtime-state/Claude/Work-A/Credentials.Json"), true);
  assert.equal(isExcludedRelativePath("Debug"), true);
  assert.equal(isExcludedRelativePath("Debug/nested/model-io.jsonl"), true);
  assert.equal(isExcludedRelativePath("cli/DEBUG/trace.log"), true);
  assert.equal(isDatabaseArchivePath("Tasks-Index.SQLITE-WAL"), true);
  // 折叠大小写只作用于凭据文件名与 EXCLUDED_ARCHIVE_DIRECTORY_NAMES 目录段这两组名单；
  // 目录前缀族（logs/sessions/dev 等）沿用原样比对，避免判定范围被无意放大。
  assert.equal(isExcludedRelativePath("Logs/2026-10-02.LOG"), false);
});

test("exportLogs.ts 不再内联路径判定，规则只有本模块一份", () => {
  const source = readSourceText(new URL("../src/main/exportLogs.ts", import.meta.url));
  // 接线（import 本模块）被改回内联时这里会红。
  assert.ok(source.includes('from "./exportLogArchivePolicy.js"'));

  // 名单与判定函数只要重新出现在 exportLogs.ts，就说明规则又有了第二份副本。
  const duplicatedDeclarations = [
    "NON_LOG_STATE_ARCHIVE_PATHS",
    "SENSITIVE_CREDENTIAL_ARCHIVE_FILE_NAMES",
    "DATABASE_ARCHIVE_FILE_SUFFIXES",
    "EXCLUDED_ARCHIVE_DIRECTORY_NAMES",
    "RETIRED_ACP_RUNTIME_ARCHIVE_PATHS",
    "HIGH_VOLUME_RUNTIME_ARCHIVE_PATHS",
    "DOCSHOT_ARCHIVE_PATH",
    "ZIP_EXCLUDE_PATTERNS",
    "function normalizeArchivePath",
    "function isExcludedRelativePath",
    "function isDatabaseArchivePath",
    "function isSensitiveCredentialArchivePath",
    "function isExcludedDirectoryArchivePath",
    "function isNonLogStateArchivePath",
    "function isRetiredAcpRuntimePath",
    "function isHighVolumeRuntimeArchivePath",
    "function isDocshotArchivePath",
    "function isExcludedCachePath",
    "function shouldApplyLogExportRetention",
  ];
  const reintroduced = duplicatedDeclarations.filter((declaration) => source.includes(declaration));
  assert.deepEqual(reintroduced, []);
});

test("保留期只作用于日志类路径", () => {
  assert.equal(shouldApplyLogExportRetention("logs/a.log"), true);
  assert.equal(shouldApplyLogExportRetention(".zcode/cli/log/a.jsonl"), true);
  assert.equal(shouldApplyLogExportRetention("settings/setting.json"), false);
});

/**
 * 构造一段必然被判为非文本的字节。三条启发式（ASCII-零字节对、空字节比例、解码后字符占比）
 * 必须全部落空才会走到 BINARY 分支，所以字节要同时满足：
 * 不含 NUL、不是合法 UTF-8（0xF8 永远非法）、且按 UTF-16 双端解码后都不落在任何
 * preferred 区间——0x28 与 0xF8 配对后 LE 得 U+F828、BE 得 U+28F8，两端都是死区。
 */
function createBinaryPayload(): Buffer {
  const bytes: number[] = [0x4d, 0x44, 0x4d, 0x50];
  for (let index = 0; index < 512; index += 1) {
    bytes.push(index % 2 === 0 ? 0x28 : 0xf8);
  }
  return Buffer.from(bytes);
}

test("复制阶段跳过非文本文件，文本文件照常脱敏", async () => {
  const sourceDir = join(testRuntimeDir, "source");
  mkdirSync(sourceDir, { recursive: true });
  const dumpPath = join(sourceDir, "memory.dmp");
  const logPath = join(sourceDir, "app.log");
  // 脱敏按键名命中即可；占位值刻意不像凭据，避免测试文件里出现密钥形态的字符串。
  const fixtureValue = "fixture-value-must-be-redacted";
  writeFileSync(dumpPath, createBinaryPayload());
  writeFileSync(logPath, `provider ${JSON.stringify({ apiKey: fixtureValue })}\n`, "utf-8");

  const outputRootDir = join(testRuntimeDir, "export");
  const result = await exportLogs({
    getZCodeDataDir: () => sourceDir,
    getExportLogDir: () => outputRootDir,
    getExportLogStageDir: () => join(testRuntimeDir, "stage"),
    showItemInFolder: () => {},
    createLogArchiveArtifacts: async () => ({
      files: [
        { absolutePath: dumpPath, archivePath: "memory.dmp" },
        { absolutePath: logPath, archivePath: "app.log" },
      ],
      aboutContent: "test",
    }),
    // 让 zip 路径失败，回退到目录导出——目录导出才会走真实的复制与跳过逻辑。
    writeLogArchiveZip: async () => {
      throw new Error("forced directory fallback");
    },
  });

  assert.equal(result.success, true);
  assert.ok(result.path);
  assert.equal(existsSync(join(result.path, "memory.dmp")), false, "非文本文件不应出现在日志包里");
  assert.equal(existsSync(join(result.path, "app.log")), true);
  assert.equal(readFileSync(join(result.path, "app.log"), "utf-8").includes(fixtureValue), false);
});
