import { mkdirSync, readFileSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gitBashPathToWindowsPath,
  type ExecutionCommand,
  type ExecutionRequest,
  type ExecutionShellDialect,
  windowsPathToGitBashPath,
} from "@zcode/contracts";

export interface CwdCapturePlan {
  command: ExecutionCommand;
  cwdFilePath?: string;
}

export function createCwdCapturePlan(
  request: ExecutionRequest,
  options: {
    dialect: ExecutionShellDialect;
    platform: NodeJS.Platform;
  },
): CwdCapturePlan {
  if (request.captureCwdAfterSuccess !== true || request.command.mode !== "shell") {
    return { command: request.command };
  }

  const cwdCaptureDir = tmpdir();
  mkdirSync(cwdCaptureDir, { recursive: true });
  const cwdFilePath = join(cwdCaptureDir, `zcode-${crypto.randomUUID()}-cwd`);

  // 每次 Bash 仍启动新 shell；成功后只把最终 pwd -P 写回主进程，不能持久化 env/alias/function。
  // 默认 shell、hooks、background command 不走这个分支，避免改变其它执行面。
  const wrappedCommand =
    options.dialect === "cmd"
      ? createWindowsCmdCwdCaptureCommand(request.command.command, cwdFilePath)
      : createPosixCwdCaptureCommand(
          request.command.command,
          options.dialect === "git-bash" ? windowsPathToGitBashPath(cwdFilePath) : cwdFilePath,
        );

  return {
    command: {
      ...request.command,
      command: wrappedCommand,
    },
    cwdFilePath,
  };
}

function createPosixCwdCaptureCommand(command: string, cwdFilePath: string): string {
  return [
    command,
    "__zcode_status=$?",
    `if [ "$__zcode_status" -eq 0 ]; then pwd -P > ${shellQuote(cwdFilePath)}; fi`,
    'exit "$__zcode_status"',
  ].join("\n");
}

function createWindowsCmdCwdCaptureCommand(command: string, cwdFilePath: string): string {
  // cmd /c 只执行传给它的命令字符串的第一行（Node 的 shell 选项固定走 /d /s /c），
  // 所以状态检查与 cwd 写回必须和用户命令拼在同一行；用 `if not errorlevel 1`
  // 在运行时读取真实 errorlevel，避免 `%ERRORLEVEL%` 在同一行被提前展开成旧值。
  // 不额外写 `exit /b`：cmd /c 的退出码仍由最后一条命令（成功时的 cd）或用户命令决定。
  return `${command} & if not errorlevel 1 cd > ${cmdQuote(cwdFilePath)}`;
}

export function readCapturedCwd(
  cwdFilePath: string | undefined,
  options: { dialect: ExecutionShellDialect },
): string | undefined {
  if (!cwdFilePath) return undefined;
  try {
    const value = readFileSync(cwdFilePath, "utf8").replace(/\r?\n$/u, "");
    if (!value) return undefined;
    const hostValue = normalizeCapturedCwdForHost(value, options.dialect);
    const stats = statSync(hostValue);
    if (!stats.isDirectory()) return undefined;
    return realpathSync(hostValue);
  } catch {
    return undefined;
  } finally {
    try {
      unlinkSync(cwdFilePath);
    } catch {
      // cwd 捕获只影响内部会话状态，清理失败不能影响工具结果。
    }
  }
}

export function normalizeCapturedCwdForHost(value: string, dialect: ExecutionShellDialect): string {
  return dialect === "git-bash" ? gitBashPathToWindowsPath(value) : value;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function cmdQuote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
