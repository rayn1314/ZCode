import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createWebRemoteControlRelayHttpServer,
  resolveLanHostAddress,
  type WebRemoteControlRelayHttpServerHandle,
} from "@zcode/server/relay";
import { createServiceLogger } from "@zcode/services/node";
import type { WebRemoteControlRelayHostStatus, WebRemoteControlRelayHost } from "@zcode/shared";

/**
 * 手机远控中转服务进程内托管：桌面 main 自己跑 relay，不依赖外部进程、不占用命令行。
 *
 * 为什么在进程内而不是 spawn：
 * - 用户点一下就要能用，spawn 还要管子进程生命周期、端口占用排查、产品更新后 bundle 路径变化；
 * - relay 是纯转发 broker，无业务状态，崩了只影响中转本身，可以随桌面一起退出；
 * - 桌面 main 已经是 Node 运行时，ws / node:http 都在手上，没有额外依赖成本。
 *
 * 约束：只绑私网地址（见 packages/server/src/relay/lanHost.ts），不触公网；
 * 已配 ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL 时本模块不参与（走外部 relay）。
 */

const WEB_REMOTE_ROUTE_PATH = "/remote/v4/";
const PORT_SEARCH_LIMIT = 20;

export interface WebRemoteControlRelayHostDependencies {
  /** dev 用仓库产物，打包态用 resourcesPath；调用方负责判定，返回 undefined 表示无静态资源可用。 */
  resolveStaticRoot(): string | undefined;
  preferredPort?: number;
  maxDevices?: number;
}

/** 静态资源按 dev / 打包两种形态就近解析，调用方由 index.ts 注入真实路径来源。 */
export function resolveBundledPwaStaticRoot(input: {
  isPackaged: boolean;
  resourcesPath?: string;
  repoRoot?: string;
}): string | undefined {
  const candidates = input.isPackaged
    ? [input.resourcesPath ? join(input.resourcesPath, "mobile-remote") : undefined]
    : [
        input.repoRoot ? join(input.repoRoot, "packages", "web", "dist") : undefined,
        input.resourcesPath ? join(input.resourcesPath, "mobile-remote") : undefined,
      ];
  for (const candidate of candidates) {
    if (candidate && existsSync(join(candidate, "index.html"))) {
      return candidate;
    }
  }
  return undefined;
}

export function createWebRemoteControlRelayHost(
  dependencies: WebRemoteControlRelayHostDependencies,
): WebRemoteControlRelayHost {
  const log = createServiceLogger("web-remote-control-relay");
  let handle: WebRemoteControlRelayHttpServerHandle | undefined;
  let starting: Promise<WebRemoteControlRelayHostStatus> | undefined;
  let status: WebRemoteControlRelayHostStatus = { state: "stopped" };
  // 显式绑定地址逃生口（ZCODE_WEB_REMODE_CONTROL_RELAY_HOST）；空则按私网默认策略探测。
  let hostOverride: string | undefined;

  const sync = (next: WebRemoteControlRelayHostStatus): WebRemoteControlRelayHostStatus => {
    status = next;
    return status;
  };

  const stop = async (): Promise<void> => {
    const current = handle;
    handle = undefined;
    starting = undefined;
    if (!current) {
      sync({ state: "stopped" });
      return;
    }
    await current.close();
    log.info("mobile remote relay stopped", { port: current.port });
    sync({ state: "stopped" });
  };

  const start = async (): Promise<WebRemoteControlRelayHostStatus> => {
    if (handle) {
      return status;
    }
    if (starting) {
      return starting;
    }

    const host = hostOverride ?? resolveLanHostAddress();
    if (!host) {
      const message =
        "未找到局域网地址，无法托管手机远控中转服务。请连接 Wi-Fi 或以太网后重试；" +
        "如需手动指定可设置 ZCODE_WEB_REMOTE_CONTROL_RELAY_HOST。";
      log.error("mobile remote relay has no lan host", { message });
      sync({ state: "error", error: message });
      throw new Error(message);
    }

    const staticRoot = dependencies.resolveStaticRoot();
    if (!staticRoot) {
      const message =
        "找不到手机端页面资源，无法托管手机远控中转服务。" +
        "开发态请先在仓库根目录构建 packages/web；打包态缺失请重新构建安装包。";
      log.error("mobile remote relay has no pwa static root", { message });
      sync({ state: "error", error: message });
      throw new Error(message);
    }

    const basePort = dependencies.preferredPort ?? 3030;
    starting = (async () => {
      let lastError: Error | undefined;
      for (let offset = 0; offset < PORT_SEARCH_LIMIT; offset += 1) {
        const port = basePort + offset;
        try {
          const created = await createWebRemoteControlRelayHttpServer({
            port,
            host,
            staticRoot: resolve(staticRoot),
            maxDevices: dependencies.maxDevices ?? 64,
            debug: false,
            logger: {
              info: (message, fields) => log.info(`[relay] ${message}`, fields),
              warn: (message, fields) => log.warn(`[relay] ${message}`, fields),
              error: (message, fields) => log.error(`[relay] ${message}`, fields),
            },
          });
          handle = created;
          const next = sync({
            state: "running",
            host,
            port: created.port,
            staticRoot: resolve(staticRoot),
          });
          log.info("mobile remote relay started", {
            host,
            port: created.port,
            staticRoot: resolve(staticRoot),
          });
          return next;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          if (!/EADDRINUSE|address already in use/i.test(lastError.message)) {
            break;
          }
        }
      }
      sync({
        state: "error",
        error:
          `手机远控中转服务启动失败（尝试端口 ${basePort}–${basePort + PORT_SEARCH_LIMIT - 1}）：` +
          `${lastError?.message ?? "未知原因"}`,
      });
      throw lastError ?? new Error("relay start failed");
    })();

    try {
      return await starting;
    } finally {
      starting = undefined;
    }
  };

  return {
    start,
    stop,
    setHostOverride: (host: string) => {
      const trimmed = host?.trim();
      hostOverride = trimmed || undefined;
    },
    getStatus: () => status,
    getRelayUrls: () => {
      const current = handle;
      if (!current) {
        return undefined;
      }
      return {
        relayWsUrl: `ws://${status.host}:${current.port}/ws`,
        remoteUrl: `http://${status.host}:${current.port}${WEB_REMOTE_ROUTE_PATH}`,
      };
    },
  };
}
