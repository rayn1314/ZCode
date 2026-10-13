#!/usr/bin/env node

// Fork 自建版 Windows 打包入口：electron-builder 打包 + exe 版本信息回填，一条命令完成。
//
// 为什么放在仓库里而不是个人构建脚本：fork 产物的身份默认值、electron-builder 必需的
// flag、rcedit 版本信息回填，都属于「这个 fork 的包怎么来」的固有知识。克隆源码的人
// 执行 `pnpm package:desktop` 就得到完全一致的包，不需要各自拼命令、也不会漏步骤
// （个人脚本手排步骤曾漏掉 agent bundle 暂存，打出缺 koffi 的包）。
// 所有身份/环境变量均可用 env 覆盖，不影响上游风格的构建。

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { runCommand } from "../../../scripts/spawn-command.mjs";
import { resolveDesktopProductIdentity } from "../../../scripts/product-identity.mjs";
import { applyForkBuildEnvDefaults } from "../../../scripts/fork-build-env.mjs";

const desktopPackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(desktopPackageRoot, "../..");

// fork 产物的身份默认值（env 可覆盖）：独立产品名/AppId 换来独立安装位与
// Electron 数据目录；preview 身份让自建包不参与官方强制更新链路。
// 单独调用本脚本时自给自足；经 package:desktop 链调用时与全链共享同一份默认值。
applyForkBuildEnvDefaults();

const identity = resolveDesktopProductIdentity(process.env);
console.log(`[package:win] product: ${identity.productName} (appId: ${identity.appId})`);

// 打包前确认没有进程正跑在产物目录里：electron-builder 清理输出目录时会被占用文件
// 挡住，只报一句 "remove ...d3dcompiler_47.dll: Access is denied"，很难联想到原因。
// 本应用关闭窗口是隐藏到托盘，只结束主进程也未必退干净，所以显式全量检查。
const distRoot = resolve(desktopPackageRoot, "dist", "win-unpacked");
const runningPids = findProcessesRunningFrom(distRoot);
if (runningPids.length > 0) {
  throw new Error(
    `[package:win] 有 ${runningPids.length} 个进程正在运行于 ${distRoot}，打包无法清理输出目录。\n` +
      `请先完全退出自建版（托盘图标右键退出；或结束所有 "${identity.productName}.exe" 进程）后重试。`,
  );
}

// signAndEditExecutable=false：app-builder 内置的 rcedit 命令会先去下载 winCodeSign
// 归档（含 macOS 符号链接），非管理员 Windows 上解压失败会让整个打包中断。
// asar 完整性不受该开关影响；exe 版本信息改由下面的 rcedit 步骤补上。
runCommand(
  "pnpm",
  [
    "exec",
    "electron-builder",
    "--config",
    "electron-builder.config.js",
    "--win",
    "--x64",
    "--dir",
    "-c.win.signAndEditExecutable=false",
  ],
  { cwd: desktopPackageRoot, env: process.env },
);

const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
const authorName = typeof pkg.author === "string" ? pkg.author : (pkg.author?.name ?? "ZCode");
const exePath = resolve(desktopPackageRoot, "dist", "win-unpacked", `${identity.productName}.exe`);
if (!existsSync(exePath)) {
  throw new Error(`[package:win] 找不到打包产物 exe：${exePath}`);
}

const rceditPath = resolveRceditPath();
if (!rceditPath) {
  // 版本信息只是资源属性，缺失不影响运行；提示而不中断，方便没有 rcedit 的环境。
  console.warn(
    "[package:win] 未找到 rcedit，跳过 exe 版本信息写入（可用 ZCODE_RACEDIT_PATH 指定）",
  );
} else {
  const iconPath = resolve(desktopPackageRoot, "build", "icon.ico");
  const args = [
    exePath,
    "--set-version-string",
    "ProductName",
    identity.productName,
    "--set-version-string",
    "FileDescription",
    identity.productName,
    "--set-version-string",
    "CompanyName",
    authorName,
    "--set-version-string",
    "LegalCopyright",
    `Copyright (C) ${new Date().getFullYear()} ${authorName}`,
    "--set-version-string",
    "InternalName",
    identity.productName,
    "--set-file-version",
    pkg.version,
    "--set-product-version",
    pkg.version,
  ];
  if (existsSync(iconPath)) args.push("--set-icon", iconPath);
  runCommand(rceditPath, args);
  console.log(`[package:win] rcedit 版本信息与图标已写入：${exePath}`);
}

// 构建收尾：确保开始菜单 / 桌面快捷方式存在（幂等，重复构建只刷新不重复问）。
// 自建版是「解压即用、无安装器」的产物，快捷方式是用户唯一的入口；第一次构建后
// 自动建好，之后「构建完就能双击启动」，不需要记住额外的安装步骤。快捷方式指向
// 仓库启动器而非 exe，始终命中最新构建产物，重建后无需重装。
// 不想自动建：ZCODE_SKIP_SHORTCUTS=1。
if (process.env.ZCODE_SKIP_SHORTCUTS === "1") {
  console.log("[package:win] ZCODE_SKIP_SHORTCUTS=1，跳过快捷方式创建");
} else {
  try {
    ensureLaunchShortcuts({ identity, desktopPackageRoot, repoRoot });
  } catch (error) {
    // 快捷方式是便利设施，建失败不能让已经打好的包算构建失败；大声提示即可。
    console.warn(`[package:win] 快捷方式创建失败（不影响产物）：${error.message}`);
  }
}

const exeSizeMb = Math.round(readFileSync(exePath).length / 1024 / 1024);
console.log(`[package:win] 完成：${exePath}（${exeSizeMb} MB）`);

function resolveRceditPath() {
  const candidates = [process.env.ZCODE_RACEDIT_PATH, resolve(repoRoot, "tools", "rcedit-x64.exe")];
  // electron-builder 的 winCodeSign 缓存：目录名固定为 winCodeSign-<version>。
  const cacheRoot = resolve(
    process.env.LOCALAPPDATA ?? process.env.HOME ?? "",
    "electron-builder",
    "Cache",
    "winCodeSign",
  );
  if (existsSync(cacheRoot)) {
    for (const entry of readdirSync(cacheRoot)) {
      candidates.push(resolve(cacheRoot, entry, "rcedit-x64.exe"));
    }
  }
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null;
}

// Windows 专属：列出可执行文件位于指定目录内的进程 PID。检查本身失败不阻塞打包，
// 交给 electron-builder 报它自己的错，避免把预检做成新的故障源。
function findProcessesRunningFrom(root) {
  const result = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "Get-Process | Where-Object { $_.Path -like ($env:ZCODE_DIST_ROOT + '\\*') } | Select-Object -ExpandProperty Id",
    ],
    { encoding: "utf8", env: { ...process.env, ZCODE_DIST_ROOT: root } },
  );
  if (result.error || result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

// Windows 专属：用 WScript.Shell COM 创建 .lnk。路径一律经环境变量传给 PowerShell，
// 避免空格/引号在命令行里被吃掉；已存在的快捷方式直接覆盖（自愈陈旧目标）。
// 用 -Command 而不是 .ps1 文件，绕开执行策略对脚本文件的限制。
function ensureLaunchShortcuts({ identity, desktopPackageRoot, repoRoot }) {
  const launcherVbs = resolve(desktopPackageRoot, "scripts", "launch-packaged-app.vbs");
  if (!existsSync(launcherVbs)) {
    console.warn("[package:win] 未找到启动器脚本，跳过快捷方式创建");
    return;
  }
  const startMenuDir = process.env.APPDATA
    ? resolve(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs")
    : "";
  const desktopDir = process.env.USERPROFILE ? resolve(process.env.USERPROFILE, "Desktop") : "";
  const linkPaths = [startMenuDir, desktopDir]
    .map((dir) => (dir ? resolve(dir, `${identity.productName}.lnk`) : ""))
    .filter(Boolean);
  if (linkPaths.length === 0) return;

  const psScript = [
    "$shell = New-Object -ComObject WScript.Shell",
    "$links = @($env:ZCODE_SHORTCUT_LINK_MENU, $env:ZCODE_SHORTCUT_LINK_DESKTOP)",
    "foreach ($linkPath in $links) {",
    "  if ([string]::IsNullOrWhiteSpace($linkPath)) { continue }",
    "  $shortcut = $shell.CreateShortcut($linkPath)",
    "  $shortcut.TargetPath = $env:ZCODE_SHORTCUT_WSCRIPT",
    "  $shortcut.Arguments = '//nologo \"' + $env:ZCODE_SHORTCUT_LAUNCHER + '\"'",
    "  $shortcut.WorkingDirectory = $env:ZCODE_SHORTCUT_WORKDIR",
    "  $shortcut.Description = $env:ZCODE_SHORTCUT_DESCRIPTION",
    "  if (Test-Path -LiteralPath $env:ZCODE_SHORTCUT_ICON) { $shortcut.IconLocation = $env:ZCODE_SHORTCUT_ICON }",
    "  $shortcut.Save()",
    "}",
  ].join("\n");

  runCommand("powershell", ["-NoProfile", "-Command", psScript], {
    env: {
      ...process.env,
      ZCODE_SHORTCUT_LINK_MENU: linkPaths[0] ?? "",
      ZCODE_SHORTCUT_LINK_DESKTOP: linkPaths[1] ?? "",
      ZCODE_SHORTCUT_WSCRIPT: resolve(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "wscript.exe",
      ),
      ZCODE_SHORTCUT_LAUNCHER: launcherVbs,
      ZCODE_SHORTCUT_WORKDIR: repoRoot,
      ZCODE_SHORTCUT_DESCRIPTION: `Launch ${identity.productName} (self-built)`,
      ZCODE_SHORTCUT_ICON: resolve(desktopPackageRoot, "build", "icon.ico"),
    },
  });
  for (const linkPath of linkPaths) console.log(`[package:win] 快捷方式已就绪：${linkPath}`);
}
