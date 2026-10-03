import { spawn } from "node:child_process";

// WSL 桥接的进程执行层。所有命令调用都用 --exec：wsl.exe 裸 `--` 会把参数交给
// WSL 侧 shell 分词，而 shell 的 cwd 是 Windows 进程 cwd 的 /mnt 映射——若 cwd
// 里恰好有 .zcode-* 文件（如打包产物内的 .zcode-install-manifest），find 的
// -name 通配会被展开吃掉，探测随之静默失真。--exec 把参数原样传给目标程序，
// 不存在 shell 展开与命令拼接面；UI 侧来的可变值一律经 encodeWslArg 转 base64url。

export type SpawnLike = typeof spawn;

export interface WslRunResult {
  status: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

function resolveSpawn(spawnImpl?: SpawnLike): SpawnLike {
  return spawnImpl ?? spawn;
}

export function runWsl(
  args: string[],
  timeoutMs: number,
  spawnImpl?: SpawnLike,
): Promise<WslRunResult> {
  return new Promise((resolve, reject) => {
    const child = resolveSpawn(spawnImpl)("wsl.exe", args, { windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill();
      reject(new Error(`wsl.exe 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    child.on("close", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          status: child.exitCode,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
        });
      }
    });
  });
}

/** 把 Windows 路径换成 WSL 里的 /mnt/<盘>/... 形式，好在 WSL 里直接运行。 */
export function wslScriptPath(winPath: string): string {
  const p = winPath.replace(/\//g, "\\");
  if (p.length > 1 && p.charAt(1) === ":") {
    return `/mnt/${p.charAt(0).toLowerCase()}${p.slice(2).replace(/\\/g, "/")}`;
  }
  return p.replace(/\\/g, "/");
}

/** UI 侧来的可变值进 wsl.exe 参数列表前的编码：base64url 字符集在任何解析器里都是惰性的。 */
export function encodeWslArg(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

/** 列出正在运行的 WSL 发行版名。只列 Running 的：探测停止的发行版会把它拉起来。
 * wsl -l -v 的输出是 UTF-16LE，列间靠空格对齐，默认发行版名前带 *。 */
export async function listRunningWslDistros(spawnImpl?: SpawnLike): Promise<string[]> {
  let result: WslRunResult;
  try {
    result = await runWsl(["-l", "-v"], 15_000, spawnImpl);
  } catch {
    return [];
  }
  const text = result.stdout.toString("utf16le").replace(/^\uFEFF/, "");
  const names: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.split(/\s+/).filter(Boolean);
    if (parts.length === 0 || (parts[0] ?? "").toUpperCase() === "NAME") {
      continue;
    }
    const stateAt = parts.findIndex((p) => p === "Running" || p === "Stopped");
    if (stateAt < 1 || parts[stateAt] !== "Running") {
      continue;
    }
    let name = parts[stateAt - 1];
    if (name === "*") {
      name = stateAt >= 2 ? parts[stateAt - 2] : "";
    }
    if (name) {
      names.push(name);
    }
  }
  return names;
}

const DB_SUFFIX = "/cli/db/db.sqlite";

/**
 * 探测一个发行版里所有装着账本库的数据根（官方 + 自建），不经任何 shell：
 * HOME/ZCODE_HOME 用 printenv 直接读；自建根的目录名通配与库文件验证全部交给
 * find 自己解释（-name/-path 的通配符由 find 处理，不是 shell 通配）。
 * find 有多个起点时，不存在的起点只写 stderr 不影响其余起点，因此不检查退出码。
 */
export async function probeWslDbRoots(distro: string, spawnImpl?: SpawnLike): Promise<string[]> {
  const printenv = async (name: string): Promise<string | null> => {
    try {
      const result = await runWsl(["-d", distro, "--exec", "printenv", name], 15_000, spawnImpl);
      if (result.status !== 0) {
        return null;
      }
      const value = result.stdout.toString("utf8").trim().split(/\r?\n/)[0]?.trim();
      return value || null;
    } catch {
      return null;
    }
  };
  const home = await printenv("HOME");
  if (!home) {
    return [];
  }
  const zcodeHome = await printenv("ZCODE_HOME");
  const candidates = [...(zcodeHome ? [zcodeHome] : []), `${home}/.zcode`, `${home}/.config/zcode`];

  try {
    const selfScan = await runWsl(
      ["-d", distro, "--exec", "find", home, "-maxdepth", "1", "-type", "d", "-name", ".zcode-*"],
      20_000,
      spawnImpl,
    );
    for (const line of selfScan.stdout.toString("utf8").split(/\r?\n/)) {
      const dir = line.trim();
      if (dir) {
        candidates.push(dir);
      }
    }
  } catch {
    // home 不可遍历时只保留官方候选
  }

  let verify: WslRunResult;
  try {
    verify = await runWsl(
      [
        "-d",
        distro,
        "--exec",
        "find",
        ...candidates,
        "-maxdepth",
        "3",
        "-type",
        "f",
        "-name",
        "db.sqlite",
        "-path",
        `*${DB_SUFFIX}`,
      ],
      30_000,
      spawnImpl,
    );
  } catch {
    return [];
  }

  const roots: string[] = [];
  const seen = new Set<string>();
  for (const line of verify.stdout.toString("utf8").split(/\r?\n/)) {
    const dbPath = line.trim();
    if (!dbPath.endsWith(DB_SUFFIX)) {
      continue;
    }
    const root = dbPath.slice(0, -DB_SUFFIX.length);
    if (root && !seen.has(root)) {
      seen.add(root);
      roots.push(root);
    }
  }
  return roots.sort();
}

/**
 * 在 WSL 里执行内嵌 dump 脚本，回传该数据源的聚合 JSON（结构由调用方按协议校验）。
 * 参数列表直通：脚本/库/价格表路径是 host 构造的文件路径，时间窗与偏移是数字，
 * UI 侧来的供应商/模型筛选值经 base64url 编码，任何一段都不会被 shell 或 wsl.exe 再解释。
 */
export async function runWslDump(params: {
  distro: string;
  scriptWinPath: string;
  pricesWinPath: string;
  dbPath: string;
  providerConfigPath: string;
  fromMs: number | null;
  toMs: number;
  tzOffsetMinutes: number;
  providerLabelFilter: string | null;
  modelId: string | null;
  spawnImpl?: SpawnLike;
  timeoutMs: number;
}): Promise<unknown> {
  const args = [
    "-d",
    params.distro,
    "--exec",
    "python3",
    wslScriptPath(params.scriptWinPath),
    "--db",
    params.dbPath,
    "--provider-config",
    params.providerConfigPath,
    "--prices",
    wslScriptPath(params.pricesWinPath),
    "--from-ms",
    params.fromMs === null ? "" : String(params.fromMs),
    "--to-ms",
    String(params.toMs),
    "--tz-offset",
    String(params.tzOffsetMinutes),
    "--provider-b64",
    encodeWslArg(params.providerLabelFilter ?? ""),
    "--model-b64",
    encodeWslArg(params.modelId ?? ""),
  ];
  const result = await runWsl(args, params.timeoutMs, params.spawnImpl);
  if (result.status !== 0) {
    const errLine = result.stderr.toString("utf8").trim().split(/\r?\n/).pop();
    throw new Error(errLine || `wsl 退出码 ${result.status}`);
  }
  return JSON.parse(result.stdout.toString("utf8")) as unknown;
}
