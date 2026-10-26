#!/usr/bin/env node

// 把仓库刚构建的 Linux Server 安装进本机 WSL。
//
// 为什么不自己解压 + 改 current.json：Server 自带 `update --from-archive`，它完成
// sha256 校验、immutable release 目录、pending 事务、稳定启动器、daemon 重启与失败回滚，
// 和桌面端在线升级走同一条路径。手写安装会漏掉 update lock、update-transaction 与回滚，
// 升级中途失败就把 WSL 留在半装状态。
//
// 用法：
//   pnpm deploy:wsl-server            # 安装并重启（有运行中任务时跳过）
//   pnpm deploy:wsl-server -- --force # 强制安装，允许中断运行中的任务
//   pnpm deploy:wsl-server -- --check # 只报告当前版本与目标版本，不改动
//
// 跳过条件（退出码 0，不阻断打包）：
//   - 本机没有配置 WSL 连接
//   - 该 WSL 从未安装过 ZCode Server（首次安装仍由桌面端连接完成）
//   - 已有运行中任务且未加 --force
//
// 打包流程 `pnpm package:desktop` 会调用本脚本；失败只告警，不影响 Windows 安装包产出。

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

function readOption(name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} 缺少参数值`);
  }
  return value;
}

function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function toWslPath(winPath) {
  const match = /^([A-Za-z]):[\\/](.*)$/u.exec(winPath);
  if (!match) return winPath.replaceAll("\\", "/");
  return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`;
}

function readWslTarget() {
  const cliDistro = readOption("--distro");
  const cliUser = readOption("--user");
  if (cliDistro) {
    return { distro: cliDistro, user: cliUser };
  }
  if (process.env.ZCODE_WSL_DISTRO) {
    return { distro: process.env.ZCODE_WSL_DISTRO, user: cliUser ?? process.env.ZCODE_WSL_USER };
  }

  const settingsPath = join(homedir(), ".zcode-rayn", "v2", "setting.json");
  if (!existsSync(settingsPath)) return null;
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const profiles = Array.isArray(settings.connectionProfiles) ? settings.connectionProfiles : [];
  const wslProfiles = profiles.filter((profile) => profile?.transport === "wsl");
  const preferred =
    wslProfiles.find((profile) => profile.lifecycleState === "active") ?? wslProfiles[0];
  if (!preferred?.target?.distro) return null;
  return { distro: preferred.target.distro, user: preferred.target.user };
}

// 部署脚本在 WSL 内执行；变量与路径都由本文件传入，避免 Windows cmd 解析把
// `$d` / `$p` 之类的变量吃掉（历史上 `wsl bash -lc` 的引号嵌套踩过这个坑）。
function renderDeployScript() {
  return `#!/usr/bin/env bash
set -euo pipefail

TARBALL="$1"
EXPECTED_SHA="$2"
TARGET_VERSION="$3"
FORCE="$4"
CHECK_ONLY="$5"

ROOT="\${ZCODE_SERVER_ROOT:-$HOME/.zcode/server-rayn}"
CURRENT="$ROOT/current.json"
LAUNCHER="$ROOT/bin/zcode"
STATUS="$ROOT/run/status.json"

echo "[deploy:wsl] server root: $ROOT"

read_json_string() {
  grep -o "\\"$2\\"[[:space:]]*:[[:space:]]*\\"[^\\"]*\\"" "$1" 2>/dev/null | head -n 1 | sed 's/.*"\\([^"]*\\)"$/\\1/'
}

read_json_number() {
  grep -o "\\"$2\\"[[:space:]]*:[[:space:]]*[0-9][0-9]*" "$1" 2>/dev/null | head -n 1 | grep -o '[0-9][0-9]*$'
}

if [ ! -f "$CURRENT" ] || [ ! -x "$LAUNCHER" ]; then
  echo "[deploy:wsl] 跳过：这台 WSL 还没安装过 ZCode Server（缺少 current.json 或 bin/zcode）。"
  echo "[deploy:wsl] 首次安装请用桌面端连接一次，之后本脚本即可接管升级。"
  exit 0
fi

if [ ! -f "$TARBALL" ]; then
  echo "[deploy:wsl] 错误：WSL 内看不到归档 $TARBALL" >&2
  echo "[deploy:wsl] 请确认该盘符已挂载到 /mnt（WSL 默认会挂载所有本地磁盘）。" >&2
  exit 1
fi

ACTUAL_SHA=$(sha256sum "$TARBALL" | awk '{print $1}')
if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
  echo "[deploy:wsl] 错误：归档 sha256 不一致" >&2
  echo "[deploy:wsl]   expected: $EXPECTED_SHA" >&2
  echo "[deploy:wsl]   actual:   $ACTUAL_SHA" >&2
  exit 1
fi

CURRENT_SHA=$(read_json_string "$CURRENT" archiveSha256)
CURRENT_VERSION=$(read_json_string "$CURRENT" version)
CURRENT_RELEASE=$(read_json_string "$CURRENT" releaseId)

echo "[deploy:wsl] 当前版本: $CURRENT_VERSION ($CURRENT_RELEASE)"
echo "[deploy:wsl] 目标版本: $TARGET_VERSION ($(printf '%s' "$EXPECTED_SHA" | cut -c1-12))"

if [ "$CURRENT_SHA" = "$EXPECTED_SHA" ]; then
  echo "[deploy:wsl] 已是最新构建，无需安装。"
  exit 0
fi

RUNNING=0
if [ -f "$STATUS" ]; then
  RUNNING=$(read_json_number "$STATUS" runningTaskCount)
  RUNNING=\${RUNNING:-0}
fi

# control.sock 可能是上次崩溃留下的残留文件，只判断文件类型会把已停机的服务当成在线，
# 随后白等 60 秒 ready。status.json 里的 pid 是 Core 进程，kill -0 才是真实存活信号。
DAEMON_ONLINE=0
DAEMON_PID=$(read_json_number "$STATUS" pid)
if [ -n "$DAEMON_PID" ] && kill -0 "$DAEMON_PID" 2>/dev/null; then
  DAEMON_ONLINE=1
fi

if [ "$CHECK_ONLY" = "1" ]; then
  echo "[deploy:wsl] --check：仅检查，不安装。运行中任务: $RUNNING，daemon: $([ "$DAEMON_ONLINE" = "1" ] && echo "online (pid $DAEMON_PID)" || echo offline)"
  exit 0
fi

if [ "$RUNNING" -gt 0 ] && [ "$FORCE" != "1" ]; then
  echo "[deploy:wsl] 跳过：WSL 上还有 $RUNNING 个运行中的任务，升级会中断它们。"
  echo "[deploy:wsl] 等任务结束后重跑 pnpm deploy:wsl-server；或强制：pnpm deploy:wsl-server -- --force"
  exit 0
fi

echo "[deploy:wsl] 开始安装（官方 update --from-archive 路径）..."
if [ "$FORCE" = "1" ]; then
  "$LAUNCHER" update --from-archive "$TARBALL" --force
else
  "$LAUNCHER" update --from-archive "$TARBALL"
fi

if [ "$DAEMON_ONLINE" = "0" ]; then
  echo "[deploy:wsl] 已安装 $TARGET_VERSION；server 当前未运行，下次从桌面端连接时会用新 release 启动。"
  exit 0
fi

for _ in $(seq 1 60); do
  NOW_SHA=$(read_json_string "$CURRENT" archiveSha256)
  NOW_STATE=$(read_json_string "$STATUS" state)
  NOW_VERSION=$(read_json_string "$STATUS" version)
  if [ "$NOW_SHA" = "$EXPECTED_SHA" ] && [ "$NOW_STATE" = "ready" ]; then
    echo "[deploy:wsl] 完成：server $NOW_VERSION 已用新 release 就绪。"
    exit 0
  fi
  sleep 1
done

echo "[deploy:wsl] 警告：安装命令已返回，但 60 秒内没有观察到新 release ready。" >&2
echo "[deploy:wsl] 请检查 $STATUS 与 $ROOT/releases/ 下的实际目录。" >&2
exit 1
`;
}

function main() {
  if (process.env.ZCODE_SKIP_WSL_DEPLOY === "1") {
    console.log("[deploy:wsl] ZCODE_SKIP_WSL_DEPLOY=1，跳过 WSL Server 部署。");
    return 0;
  }

  const force = args.includes("--force");
  const checkOnly = args.includes("--check");

  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const version = packageJson.version;
  const releaseDir = join(repoRoot, "packages", "desktop", "mock-cdn", "releases", version);
  const descriptorPath = join(releaseDir, "source-server-release.json");
  const archivePath = join(releaseDir, "zcode-server-linux-x64.tar.gz");

  if (!existsSync(descriptorPath) || !existsSync(archivePath)) {
    console.error(
      `[deploy:wsl] 找不到 ${version} 的 Linux Server 归档：${archivePath}\n` +
        `[deploy:wsl] 先执行 pnpm prepare:remote-assets 生成远端资产。`,
    );
    return 1;
  }

  const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
  const descriptorArchive = descriptor.archives?.find((entry) => entry.target === "linux-x64");
  if (!descriptorArchive) {
    console.error(`[deploy:wsl] ${descriptorPath} 里没有 linux-x64 条目。`);
    return 1;
  }

  const actualSha = sha256File(archivePath);
  if (actualSha !== descriptorArchive.sha256) {
    console.error(
      `[deploy:wsl] 归档与清单不一致，拒绝部署：\n` +
        `[deploy:wsl]   descriptor: ${descriptorArchive.sha256}\n` +
        `[deploy:wsl]   actual:     ${actualSha}`,
    );
    return 1;
  }

  const target = readWslTarget();
  if (!target) {
    console.log(
      "[deploy:wsl] 本机没有配置 WSL 连接，跳过。\n" +
        "[deploy:wsl] 如需指定：pnpm deploy:wsl-server -- --distro Ubuntu --user <用户>",
    );
    return 0;
  }

  const temporaryDir = mkdtempSync(join(tmpdir(), "zcode-wsl-deploy-"));
  const scriptPath = join(temporaryDir, "deploy.sh");
  writeFileSync(scriptPath, renderDeployScript(), "utf8");

  const wslArgs = ["-d", target.distro];
  if (target.user) wslArgs.push("-u", target.user);
  wslArgs.push(
    "--",
    "bash",
    toWslPath(scriptPath),
    toWslPath(archivePath),
    descriptorArchive.sha256,
    version,
    force ? "1" : "0",
    checkOnly ? "1" : "0",
  );

  try {
    const result = spawnSync("wsl", wslArgs, { stdio: "inherit" });
    if (result.error) {
      console.error(`[deploy:wsl] 无法启动 wsl：${result.error.message}`);
      return 1;
    }
    return result.status ?? 1;
  } finally {
    rmSync(temporaryDir, { recursive: true, force: true });
  }
}

process.exitCode = main();
