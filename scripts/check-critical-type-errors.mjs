#!/usr/bin/env node
/**
 * 致命类型错误检查：只拦"编译器一眼可见、但打包器不会拦"的那一类诊断。
 *
 * 为什么单独存在：packages/desktop 的 main / preload / renderer / scheduler 四个子工程
 * 不在根 `pnpm typecheck` 的工程清单里，而它们的产物由 tsup(esbuild) 逐文件转译 ——
 * esbuild 不做类型检查，遇到没有声明过的标识符既不报错也不回退，而是原样输出成一个
 * 自由变量引用，直到运行到那一行才抛 `ReferenceError: xxx is not defined`。
 * 2026-10-18 的手机远控黑屏就是这么来的：`src/main/index.ts` 用了一个没写进 import 的
 * 常量，typecheck（不覆盖该工程）、lint（未开 no-undef）、打包（不检查）三道门禁全没拦住。
 *
 * 这里只对"找不到名字 / 模块没有该导出 / 找不到模块"这几个必然导致运行时崩溃的诊断码设卡，
 * 不对其余既存类型错误设卡：desktop 子工程当前仍有约 150 条历史错误，全量设卡会让门禁立刻变红，
 * 于是这个脚本改用基线记账 —— 只拦新增，既存问题留在基线里，改好之后用 `--update` 收敛。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = join(repoRoot, "scripts", "critical-type-errors.baseline.json");
const cacheDir = join(repoRoot, "node_modules", ".cache", "zcode-critical-typecheck");
const tscBin = join(repoRoot, "node_modules", "typescript", "bin", "tsc");

/** 需要兜底检查的工程：根 typecheck 的覆盖范围之外、产物又走 esbuild 转译的那几个。 */
const TARGETS = [
  { label: "desktop main", config: "packages/desktop/tsconfig.main.json" },
  { label: "desktop preload", config: "packages/desktop/tsconfig.preload.json" },
  { label: "desktop renderer", config: "packages/desktop/tsconfig.renderer.json" },
  { label: "desktop scheduler", config: "packages/desktop/tsconfig.scheduler.json" },
];

/**
 * TS2304 找不到名字 / TS2305 模块没有该导出 / TS2306 不是模块 /
 * TS2307 找不到模块 / TS2459 模块内声明了但未导出 / TS2552 找不到名字（附建议）
 */
const FATAL_CODES = new Set(["TS2304", "TS2305", "TS2306", "TS2307", "TS2459", "TS2552"]);

/** 形如 `src/main/index.ts(969,60): error TS2304: Cannot find name 'X'.` */
const DIAGNOSTIC_PATTERN = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

const updateBaseline = process.argv.slice(2).includes("--update");

function runTsc(target) {
  const configPath = join(repoRoot, target.config);
  if (!existsSync(configPath)) {
    fail(`找不到 ${target.config}，请同步更新本脚本的 TARGETS。`);
  }
  mkdirSync(cacheDir, { recursive: true });
  // 直接用 node 跑 tsc 入口：不依赖 shell 能否解析 pnpm/npx（钩子环境里常常解析不到）。
  const result = spawnSync(
    process.execPath,
    [
      tscBin,
      "-p",
      configPath,
      "--noEmit",
      // 指定缓存位置，避免 buildinfo 落在工程根或 outDir 里污染工作区；
      // 有缓存时单次检查是秒级，冷启动才需要完整跑一遍。
      "--tsBuildInfoFile",
      join(cacheDir, `${basename(target.config)}.tsbuildinfo`),
    ],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error) {
    fail(`执行 tsc 失败：${result.error.message}`);
  }
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

function collectFindings() {
  const findings = new Map();
  const unparsed = [];
  for (const target of TARGETS) {
    for (const rawLine of runTsc(target).split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const matched = DIAGNOSTIC_PATTERN.exec(line);
      if (!matched) {
        // 不带 file(line,col) 前缀的 error TS 行只可能是配置级失败（例如 TS5058 路径不存在），
        // 这种必须原样暴露，否则门禁会在"根本没跑起来"的情况下报通过。
        if (/error TS\d+/.test(line)) unparsed.push(`[${target.label}] ${line}`);
        continue;
      }
      const [, rawFile, , , code, message] = matched;
      if (!FATAL_CODES.has(code)) continue;
      const absolute = isAbsolute(rawFile) ? rawFile : resolve(repoRoot, rawFile);
      const file = relative(repoRoot, absolute).split(sep).join("/");
      // 不含行号：修好别处导致的行号漂移不该让基线失效，真正的信号是"哪个文件引用了什么"。
      const key = `${target.label}|${file}|${code}|${message}`;
      const existing = findings.get(key);
      if (existing) existing.positions.push(`${rawFile}:${matched[2]}`);
      else findings.set(key, { key, label: target.label, file, code, message, positions: [] });
    }
  }
  if (unparsed.length > 0) {
    fail(`tsc 未能完整执行（以下不是普通类型错误，请先修好工程配置）：\n${unparsed.join("\n")}`);
  }
  return findings;
}

function readBaseline() {
  if (!existsSync(baselinePath)) return new Set();
  const parsed = JSON.parse(readFileSync(baselinePath, "utf8"));
  if (!Array.isArray(parsed.entries)) fail(`${baselinePath} 格式不正确：缺少 entries 数组。`);
  return new Set(parsed.entries);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const findings = collectFindings();
const baseline = readBaseline();
const currentKeys = [...findings.keys()];

if (updateBaseline) {
  const sorted = [...currentKeys].sort();
  writeFileSync(
    baselinePath,
    `${JSON.stringify(
      {
        // 只记"文件 + 诊断码 + 消息"三要素，不含行号：修好别处引起的行号漂移不该让基线失效。
        description:
          "pnpm typecheck:critical 的既存致命类型错误基线；修好问题后用 --update 收敛，新增项会挡住门禁。",
        entries: sorted,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  process.stdout.write(`已写入基线：${relative(repoRoot, baselinePath)}（${sorted.length} 条）\n`);
  process.exit(0);
}

const added = currentKeys.filter((key) => !baseline.has(key)).sort();
const stale = [...baseline].filter((key) => !findings.has(key)).sort();

if (added.length > 0) {
  const details = added
    .map((key) => {
      const finding = findings.get(key);
      return `  [${finding.label}] ${finding.file}\n    ${finding.code} ${finding.message}`;
    })
    .join("\n");
  process.stderr.write(
    `\n✗ 发现 ${added.length} 个新的致命类型错误：\n\n${details}\n\n` +
      "这几个诊断码属于「编译器一眼可见、打包器不会拦」的一类：desktop 子工程不在根\n" +
      "`pnpm typecheck` 覆盖范围内，产物由 esbuild 逐文件转译，未声明的标识符会被原样\n" +
      "输出成自由变量引用，直到运行到那一行才抛 ReferenceError。\n" +
      "修复：补上缺失的 import，或改掉已经不存在的导出名。\n" +
      "确属既存问题需要先记账时：pnpm typecheck:critical -- --update\n\n",
  );
  process.exit(1);
}

if (stale.length > 0) {
  process.stdout.write(
    `注意：基线里有 ${stale.length} 条已不再出现，可执行 pnpm typecheck:critical -- --update 收敛。\n`,
  );
}
process.stdout.write(
  `✓ 致命类型错误检查通过（${TARGETS.length} 个工程，基线 ${baseline.size} 条，无新增）\n`,
);
