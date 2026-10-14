#!/usr/bin/env node
// 手机远控一键启动 —— 把「构建 relay → 构建 PWA → 起服务 → 配桌面环境变量」压缩成一条命令。
//
// 为什么需要它：Web 远控的桌面端与手机端在仓库里都已实现，缺的只有自建 relay 服务端；
// 而手工搭要记 4 个步骤、还要在每次换网络后重编 PWA。PWA 侧已改为按运行期自身 origin
// 推导 relay 地址（见 packages/web/src/main.tsx 的 resolveExternalRelayWsUrl），
// 因此这里只需构建一次，之后换 IP / 换网络都不必再构建。
//
// 桌面侧也免配置：relay 地址会写进桌面数据根的 mobile-remote.json，桌面启动时读它，
// 优先级为「环境变量 > 该文件 > 官方默认」，所以自建用户不需要改任何启动脚本。
//
// 用法：pnpm remote:up [--port 3030] [--skip-build] [--build-only] [--no-write-config]
// 退出：Ctrl+C（会一并停掉 relay 子进程）

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const relayEntry = path.join(repoRoot, "packages", "server", "dist", "entry-relay.js");
const pwaDist = path.join(repoRoot, "packages", "web", "dist");
const pwaEntry = path.join(pwaDist, "index.html");
// vite build 会清空 dist，所以"本次构建用了哪个 base"只能在构建后落一个标记；
// 仅凭 index.html 存在无法区分 /remote/ 与 /remote/v4/，复用错 base 会让静态资源 404。
const pwaBaseMarker = path.join(pwaDist, ".remote-base");
// 与官方 build:web-remote-control:v4 保持一致：版本守卫只在 /remote/v4 路径生效。
const pwaBasePath = "/remote/v4/";

const args = process.argv.slice(2);
const readFlag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const hasFlag = (name) => args.includes(`--${name}`);
const port = Number(readFlag("port", process.env.PORT ?? "3030"));
const skipBuild = hasFlag("skip-build");

const log = (message) => console.log(`[remote:up] ${message}`);
const fail = (message) => {
  console.error(`[remote:up] ${message}`);
  process.exit(1);
};

const run = (command, commandArgs, label, extraEnv) => {
  log(`${label}…`);
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
  if (result.status !== 0) fail(`${label}失败（exit ${result.status}）`);
};

const commandFor = (script) =>
  process.platform === "win32" ? ["cmd", ["/d", "/s", "/c", script]] : ["sh", ["-c", script]];

const pwaBaseMatches = () => {
  if (!existsSync(pwaEntry) || !existsSync(pwaBaseMarker)) return false;
  try {
    return readFileSync(pwaBaseMarker, "utf8").trim() === pwaBasePath;
  } catch {
    return false;
  }
};

const ensureArtifacts = () => {
  if (skipBuild) {
    if (!existsSync(relayEntry)) fail("--skip-build 但缺少 relay 产物，请先跑 pnpm remote:build");
    if (!pwaBaseMatches()) {
      fail("--skip-build 但 PWA 产物缺失或 base 不匹配，请先跑 pnpm remote:build");
    }
    return;
  }
  if (!existsSync(relayEntry))
    run("pnpm", ["--filter", "@zcode/server", "run", "build:relay"], "构建 relay");
  if (!pwaBaseMatches()) {
    // 路由路径是构建期决定的（resolveWebRemoteControlRoutePath 读 VITE_WEB_REMOTE_CONTROL_ROUTE_PATH
    // 或 VITE_ZCODE_BASE_URL 的 pathname），必须与 base 显式对齐；只传 --base 会让路由落在 /remote，
    // 手机打开 /remote/v4/ 时走错分支。relay 地址是运行期按 origin 推导的，与网络无关，故只需构建一次。
    const [cmd, cmdArgs] = commandFor(
      `pnpm --filter @zcode/web exec vite build --base=${pwaBasePath}`,
    );
    run(cmd, [...cmdArgs], "构建手机端 PWA", {
      VITE_WEB_REMOTE_CONTROL_ROUTE_PATH: pwaBasePath,
    });
    writeFileSync(pwaBaseMarker, `${pwaBasePath}\n`);
  }
};

/** 取本机可被局域网访问的 IPv4；VMware/VirtualBox 等虚拟网卡排最后。 */
const listLanAddresses = () => {
  const candidates = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal) continue;
      const virtual = /^(vmnet|vboxnet|veth|docker|br-|utun|tailscale|wsl|hyper-v)/i.test(name);
      candidates.push({ address: address.address, virtual, name });
    }
  }
  const preferred = candidates.filter((item) => !item.virtual);
  const ordered = preferred.length > 0 ? preferred : candidates;
  // 常见家用/办公网段优先，减少在多网卡机器上选错的可能。
  ordered.sort((a, b) => score(a.address) - score(b.address));
  return ordered;
};

const score = (address) => {
  if (address.startsWith("192.168.")) return 0;
  if (address.startsWith("10.")) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 2;
  return 3;
};

const waitForHealth = async (url, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return true;
    } catch {
      // relay 尚未就绪，继续等
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
};

const assertPortFree = () =>
  new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "0.0.0.0");
  });

/**
 * 桌面数据根：`{ZCODE_DATA_BASE_DIR or home}/.zcode{suffix}`。
 * 后缀必须与桌面产物一致：直接问 product-identity 的同一函数，避免两处规则漂移后
 * 写进去的配置桌面读不到。
 */
const resolveDesktopDataRoot = async () => {
  if (process.env.ZCODE_DATA_ROOT?.trim()) {
    return process.env.ZCODE_DATA_ROOT.trim();
  }
  const { resolveDesktopProductIdentity } = await import("./product-identity.mjs");
  const suffix = resolveDesktopProductIdentity().dataRootSuffix;
  return path.join(process.env.ZCODE_DATA_BASE_DIR?.trim() || homedir(), `.zcode${suffix}`);
};

/** 把 relay 地址写给桌面；桌面启动时读它，自建用户无需配环境变量。 */
const writeDesktopRemoteConfig = async () => {
  if (hasFlag("no-write-config")) return;
  try {
    const configDir = await resolveDesktopDataRoot();
    mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, "mobile-remote.json");
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          relayWsUrl,
          remoteUrl: pwaUrl,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );
    log(`已写入桌面配置：${configPath}（桌面重启后生效，无需设环境变量）`);
  } catch (error) {
    // 写失败不阻断：用户仍可照②用环境变量方式配。
    log(`写桌面配置失败，可改用环境变量方式：${error instanceof Error ? error.message : error}`);
  }
};

ensureArtifacts();

if (hasFlag("build-only")) {
  log("产物已就绪（relay + PWA）。启动服务请跑 pnpm remote:up。");
  process.exit(0);
}

if (!(await assertPortFree())) {
  fail(`端口 ${port} 已被占用。换一个：pnpm remote:up -- --port 3040`);
}

const lanAddresses = listLanAddresses();
if (lanAddresses.length === 0) {
  fail("没有找到可用的局域网 IPv4 地址，手机将无法访问本机。");
}
const primary = lanAddresses[0].address;
const pwaUrl = `http://${primary}:${port}${pwaBasePath}`;
const relayWsUrl = `ws://${primary}:${port}/ws`;

const child = spawn(process.execPath, [relayEntry], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PORT: String(port),
    ZCODE_RELAY_HOST: "0.0.0.0",
    ZCODE_WEB_STATIC_ROOT: pwaDist,
  },
  stdio: ["ignore", "inherit", "inherit"],
});

let shuttingDown = false;
const shutdown = (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`收到 ${signal}，正在停止 relay…`);
  child.kill("SIGTERM");
  // 给子进程留出退出时间，避免 Windows 上残留占用端口。
  setTimeout(() => process.exit(0), 400);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
child.on("exit", (code) => {
  if (!shuttingDown) fail(`relay 进程已退出（code ${code}）`);
});

if (!(await waitForHealth(`http://127.0.0.1:${port}/healthz`, 15000))) {
  shutdown("health-timeout");
  fail("relay 启动超时，请检查上面的日志输出。");
}

// 桌面侧免配置：把地址写进桌面数据根，桌面前两步都是自动的。
await writeDesktopRemoteConfig();

const bar = "─".repeat(64);
console.log(`\n${bar}`);
log("手机远控已就绪 ✅");
console.log(bar);
console.log(`\n  ① 手机连到与电脑相同的 Wi-Fi，浏览器打开：\n`);
console.log(`       ${pwaUrl}\n`);
console.log(`  ② 重启 ZCode → 打开「移动端远程控制」→ 用手机扫二维码\n`);
console.log(`  （relay 地址已自动写给桌面；若你习惯用环境变量，等价于：`);
console.log(`   ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL=${relayWsUrl}`);
console.log(`   ZCODE_WEB_REMOTE_CONTROL_URL=${pwaUrl} ）\n`);
if (lanAddresses.length > 1) {
  console.log(`  本机有多个网卡，若手机连不上可改用：`);
  for (const item of lanAddresses.slice(1)) {
    console.log(`       http://${item.address}:${port}${pwaBasePath}   （${item.name}）`);
  }
  console.log("");
}
console.log(`${bar}\n`);
log("relay 运行中（日志实时输出）。按 Ctrl+C 停止。\n");
