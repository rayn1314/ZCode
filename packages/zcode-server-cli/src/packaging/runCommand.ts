import { spawn } from "node:child_process";

// Windows 上 pnpm / npm 由 cmd 批处理垫片提供，spawn 不带 shell 只认 .exe，直接 ENOENT。
// 与 scripts/spawn-command.mjs 同一套结论：保留裸命令名交给 cmd 解析 shim，不能改写成
// `pnpm.cmd`——那会让 `pnpm exec` 落回错误的包 cwd（详见该文件注释）。
const windowsShellCommandPattern = /\.(cmd|bat)$/i;
const windowsShellCommandNames = new Set(["npm", "pnpm"]);

// cmd.exe 按空格分词，含空格的参数补双引号，避免仓库路径含空格时被截断。
function quoteArgsForWindowsShell(args: readonly string[]): string[] {
  return args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg));
}

export interface RunCommandOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** 这些打包命令都不读 stdin；默认 "ignore" 让交互式提示立即失败而非挂死。 */
  stdin?: "inherit" | "ignore";
}

export async function runCommand(
  command: string,
  args: readonly string[],
  options: RunCommandOptions,
): Promise<void> {
  const useShell =
    process.platform === "win32" &&
    (windowsShellCommandPattern.test(command) || windowsShellCommandNames.has(command));
  await new Promise<void>((resolvePromise, rejectPromise) => {
    // shell:true 下仍传 args 数组会触发 Node 24 的 DEP0190 运行时弃用警告，
    // 因此 shell 路径直接拼好完整命令行交给 cmd。
    const child = useShell
      ? spawn([command, ...quoteArgsForWindowsShell(args)].join(" "), {
          cwd: options.cwd,
          env: options.env,
          stdio: [options.stdin ?? "ignore", "inherit", "inherit"],
          shell: true,
        })
      : spawn(command, [...args], {
          cwd: options.cwd,
          env: options.env,
          stdio: [options.stdin ?? "ignore", "inherit", "inherit"],
        });
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else
        rejectPromise(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "null"}`));
    });
  });
}
