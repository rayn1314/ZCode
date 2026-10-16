import { pathToFileURL } from "node:url";
import {
  createWebRemoteControlRelayHttpServer,
  createRelayConsoleLogger,
  type WebRemoteControlRelayHttpServerConfig,
} from "./relay/relayHttpServer.js";

/**
 * 自建 Web 远程控制 relay 的命令行入口。
 *
 * 服务端引导实现在 ./relay/relayHttpServer.ts，由本入口与桌面进程内托管
 * （packages/desktop/src/main/webRemoteControlRelayHost.ts）共用，避免两份实现漂移。
 * 环境变量：
 * - PORT（默认 3030）、ZCODE_RELAY_HOST / HOST
 * - ZCODE_WEB_STATIC_ROOT：指向 PWA 产物根目录时顺带托管静态资源（SPA fallback）
 * - ZCODE_RELAY_MAX_DEVICES：设备数上限，默认 64
 * - ZCODE_RELAY_DEBUG=1：输出 data 帧的高频调试日志（只含安全元数据）
 */

const DEFAULT_MAX_DEVICES = 64;

function readTrimmedEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function readRelayConfig(): WebRemoteControlRelayHttpServerConfig {
  const rawMaxDevices = Number(readTrimmedEnv("ZCODE_RELAY_MAX_DEVICES"));
  const maxDevices =
    Number.isFinite(rawMaxDevices) && rawMaxDevices > 0
      ? Math.floor(rawMaxDevices)
      : DEFAULT_MAX_DEVICES;
  return {
    port: Number(process.env["PORT"]) || 3030,
    host: readTrimmedEnv("ZCODE_RELAY_HOST") ?? readTrimmedEnv("HOST"),
    staticRoot: readTrimmedEnv("ZCODE_WEB_STATIC_ROOT"),
    maxDevices,
    debug: readTrimmedEnv("ZCODE_RELAY_DEBUG") === "1",
    logger: createRelayConsoleLogger(process.pid),
  };
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(entry as string).href;
}

// 只在作为 Node 入口直接执行时启动；被动态 import（如构建产物自检）时不产生副作用。
if (isMainModule()) {
  const config = readRelayConfig();
  const handle = await createWebRemoteControlRelayHttpServer(config);
  const host = config.host ?? "0.0.0.0";
  createRelayConsoleLogger(process.pid).info("relay listening", {
    url: `ws://${host}:${handle.port}/ws`,
    healthz: `http://${host}:${handle.port}/healthz`,
    max_devices: config.maxDevices,
    static_root: config.staticRoot ?? null,
    debug: config.debug,
  });
}
