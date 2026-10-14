import type { WebRemoteControlRelayErrorCode } from "@zcode/shared";
import { safePayloadMetadata } from "./relayFrameFields.js";
import {
  WebRemoteControlRelayRegistry,
  type RelayConnection,
  type WebRemoteControlRelayLogger,
  type WebRemoteControlRelaySocket,
} from "./webRemoteControlRelayRegistry.js";

/**
 * relay 数据面：data 帧按原始文本逐字节透传，不解析 payload（spec「数据面」节）。
 *
 * - 未配对（含连接尚未认证）静默丢弃：不缓存、不排队；
 * - 已配对但对端 socket 缺失时回 INTERNAL 且不断连——官方 relay 在该窗口就是这个
 *   语义，桌/手机 transport 的 INTERNAL 分支依赖它继续等待重新 matched。
 */

export interface WebRemoteControlRelayDataPlaneDeps {
  registry: WebRemoteControlRelayRegistry;
  sendError(
    socket: WebRemoteControlRelaySocket,
    code: WebRemoteControlRelayErrorCode,
    message: string,
  ): void;
  /** 原始帧发送；失败（对端已消失）时返回 false。 */
  sendFrame(socket: WebRemoteControlRelaySocket, data: string): boolean;
  logger?: WebRemoteControlRelayLogger;
}

export class WebRemoteControlRelayDataPlane {
  constructor(private readonly deps: WebRemoteControlRelayDataPlaneDeps) {}

  forward(connection: RelayConnection, rawText: string, payload: unknown): void {
    const bytes = Buffer.byteLength(rawText, "utf8");
    const metadata = safePayloadMetadata(payload);
    if (!connection.authenticated) {
      this.deps.logger?.debug?.("relay data dropped before authentication", {
        bytes,
        ...metadata,
      });
      return;
    }

    if (connection.role === "device") {
      const device = connection.deviceSid
        ? this.deps.registry.getDevice(connection.deviceSid)
        : undefined;
      const terminal = device?.terminalSid
        ? this.deps.registry.getTerminal(device.terminalSid)
        : undefined;
      if (!terminal) {
        this.deps.logger?.debug?.("relay data dropped without paired terminal", {
          bytes,
          ...metadata,
        });
        return;
      }
      this.forwardTo(connection.socket, terminal.socket, rawText, bytes, metadata);
      return;
    }

    const terminal = connection.terminalSid
      ? this.deps.registry.getTerminal(connection.terminalSid)
      : undefined;
    const device = connection.deviceSid
      ? this.deps.registry.getDevice(connection.deviceSid)
      : undefined;
    if (!terminal || !device) {
      this.deps.logger?.debug?.("relay data dropped without paired device", { bytes, ...metadata });
      return;
    }
    const deviceSocket = device.socket;
    if (!deviceSocket || !this.deps.registry.isDeviceOnline(device)) {
      this.deps.sendError(connection.socket, "INTERNAL", "Paired device is currently offline.");
      return;
    }
    this.forwardTo(connection.socket, deviceSocket, rawText, bytes, metadata);
  }

  private forwardTo(
    from: WebRemoteControlRelaySocket,
    to: WebRemoteControlRelaySocket,
    rawText: string,
    bytes: number,
    metadata: Record<string, string | undefined>,
  ): void {
    if (!this.deps.sendFrame(to, rawText)) {
      this.deps.sendError(from, "INTERNAL", "Paired peer is no longer reachable.");
      return;
    }
    this.deps.logger?.debug?.("relay data forwarded", { bytes, ...metadata });
  }
}
