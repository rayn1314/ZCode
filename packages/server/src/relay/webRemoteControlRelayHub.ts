import { randomBytes } from "node:crypto";
import type {
  WebRemoteControlRelayErrorCode,
  WebRemoteControlRelayIncomingMessage,
  WebRemoteControlRelayOutgoingMessage,
  WebRemoteControlRelayPairStatus,
} from "@zcode/shared";
import { calculateRelayProof, relayProofEquals } from "./relayAuth.js";
import { isRecord, isRelayEnvelope, readNonEmptyString } from "./relayFrameFields.js";
import { WebRemoteControlRelayDataPlane } from "./webRemoteControlRelayDataPlane.js";
import {
  WebRemoteControlRelayRegistry,
  type RelayConnection,
  type RelayDeviceRecord,
  type WebRemoteControlRelayLogger,
  type WebRemoteControlRelaySocket,
} from "./webRemoteControlRelayRegistry.js";

/**
 * Web 远程控制 relay 的控制面：帧解析、注册、鉴权挑战与配对状态应答，不解析 data.payload。
 *
 * 状态簿记在 WebRemoteControlRelayRegistry，data 帧透传在 WebRemoteControlRelayDataPlane；
 * 本类只编排协议。契约见 packages/server/spec/web-remote-control-relay.md。
 * 物理帧大小上限由传输边界（entry-relay）强制执行，这里不重复校验。
 */

const DEFAULT_MAX_DEVICES = 64;

export interface WebRemoteControlRelayHubOptions {
  maxDevices?: number;
  logger?: WebRemoteControlRelayLogger;
  /** 仅用于给 relay 自发消息盖 server_ts；测试可注入固定时钟。 */
  now?: () => number;
  /** 随机标识源（device_sid / terminal_sid / nonce）；测试可注入确定性序列。 */
  createId?: () => string;
}

/** 客户端 → relay 的单个消息类型；handler 只接收自己那一种，便于字段校验。 */
type RelayClientMessage<TType extends WebRemoteControlRelayOutgoingMessage["type"]> = Extract<
  WebRemoteControlRelayOutgoingMessage,
  { type: TType }
>;

// hub 的公开 API（handleConnection / options.logger）引用这两个类型，随本模块一起导出，
// 调用方（entry-relay、测试）不需要知道内部拆出了 registry 模块。
export type {
  WebRemoteControlRelayLogger,
  WebRemoteControlRelaySocket,
} from "./webRemoteControlRelayRegistry.js";

export class WebRemoteControlRelayHub {
  private readonly registry: WebRemoteControlRelayRegistry;
  private readonly dataPlane: WebRemoteControlRelayDataPlane;
  private readonly logger?: WebRemoteControlRelayLogger;
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(options: WebRemoteControlRelayHubOptions = {}) {
    const maxDevices = Math.max(1, Math.floor(options.maxDevices ?? DEFAULT_MAX_DEVICES));
    this.logger = options.logger;
    this.registry = new WebRemoteControlRelayRegistry({ maxDevices, logger: options.logger });
    this.now = options.now ?? (() => Date.now());
    this.createId = options.createId ?? (() => randomBytes(16).toString("base64url"));
    this.dataPlane = new WebRemoteControlRelayDataPlane({
      registry: this.registry,
      sendError: (socket, code, message) => {
        this.sendError(socket, code, message);
      },
      sendFrame: (socket, data) => this.trySend(socket, data),
      logger: options.logger,
    });
  }

  handleConnection(socket: WebRemoteControlRelaySocket): void {
    this.registry.attach(socket);
  }

  /**
   * 处理一条已通过传输层大小校验的物理帧。
   * data 帧必须逐字节透传，因此保留原始文本，不重新序列化。
   */
  handleMessage(socket: WebRemoteControlRelaySocket, rawText: string): void {
    const connection = this.registry.getConnection(socket);
    if (!connection) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      this.rejectFrame(socket, "Relay frame is not valid JSON.");
      return;
    }
    // isRelayEnvelope 只做布尔判断、不收窄类型，parsed 保持 unknown，
    // 这里的转换才是「未知 JSON → 协议联合」的唯一入口。
    if (!isRelayEnvelope(parsed)) {
      this.rejectFrame(socket, "Relay frame is not a relay envelope.");
      return;
    }

    const message = parsed as WebRemoteControlRelayOutgoingMessage;
    // default 分支里 message 会被收窄成 never，错误信息需要的 type 先取出来。
    const messageType = (message as { type: string }).type;
    switch (message.type) {
      case "device_register_init":
        this.handleDeviceRegisterInit(connection, message);
        return;
      case "auth_init":
        this.handleAuthInit(connection, message);
        return;
      case "auth_response":
        this.handleAuthResponse(connection, message);
        return;
      case "pair_status_query":
        this.handlePairStatusQuery(connection, message);
        return;
      case "data":
        this.dataPlane.forward(connection, rawText, message.payload);
        return;
      default:
        this.sendError(socket, "WRONG_PARAM", `Unsupported relay message type: ${messageType}`);
    }
  }

  handleDisconnect(socket: WebRemoteControlRelaySocket): void {
    this.registry.detach(socket);
  }

  private handleDeviceRegisterInit(
    connection: RelayConnection,
    message: RelayClientMessage<"device_register_init">,
  ): void {
    const deviceMid = readNonEmptyString(message.device_mid);
    const passHash = readNonEmptyString(message.pass_hash);
    // relay 不消费 meta 内容，只按协议校验必需字段存在。
    if (!deviceMid || !passHash || !isRecord(message.meta)) {
      this.sendError(
        connection.socket,
        "WRONG_PARAM",
        "device_register_init requires device_mid, pass_hash and meta.",
      );
      return;
    }

    const previous = this.registry.findDeviceByMid(deviceMid);
    if (previous) {
      // 同一 device_mid 重复注册：作废旧 device_sid 并断开旧 socket，旧二维码随之失效。
      const staleSocket = this.registry.retireDevice(previous, connection.socket);
      if (staleSocket) {
        this.closeSocket(staleSocket);
      }
    } else if (!this.registry.reserveDeviceSlot(deviceMid)) {
      this.logger?.warn("device registry full");
      this.sendError(
        connection.socket,
        "INTERNAL",
        "Relay device registry is full; please retry later.",
      );
      return;
    }

    const deviceSid = `dvc_${this.createId()}`;
    this.registry.addDevice({
      deviceSid,
      deviceMid,
      passHash,
      socket: connection.socket,
      authenticated: false,
    });
    connection.role = "device";
    connection.deviceSid = deviceSid;
    connection.terminalSid = undefined;
    connection.authenticated = false;
    connection.pending = undefined;
    this.send(connection.socket, { type: "device_register_ack", device_sid: deviceSid });
    this.logger?.info("device registered", { device_sid: deviceSid, device_mid: deviceMid });
  }

  private handleAuthInit(
    connection: RelayConnection,
    message: RelayClientMessage<"auth_init">,
  ): void {
    const role = message.role;
    const deviceSid = readNonEmptyString(message.device_sid);
    if ((role !== "device" && role !== "terminal") || !deviceSid || !isRecord(message.meta)) {
      this.sendError(
        connection.socket,
        "WRONG_PARAM",
        "auth_init requires a valid role, device_sid and meta.",
      );
      return;
    }

    const device = this.registry.getDevice(deviceSid);
    if (!device) {
      // 桌面用持久化 sid 重连但 relay 已无该注册（典型：relay 重启）→ AUTH_FAILED，
      // 桌面据此重新注册；手机拿到不存在的 sid → DEVICE_OFFLINE，走宽限重连。
      this.sendError(
        connection.socket,
        role === "device" ? "AUTH_FAILED" : "DEVICE_OFFLINE",
        "device_sid is not registered on this relay.",
      );
      return;
    }

    if (role === "device") {
      const staleSocket = this.registry.displaceDeviceSocket(device, connection.socket);
      if (staleSocket) {
        this.closeSocket(staleSocket);
      }
    }

    connection.role = role;
    connection.deviceSid = deviceSid;
    connection.terminalSid = undefined;
    connection.authenticated = false;
    connection.pending = { nonce: this.createId(), role, deviceSid };
    this.send(connection.socket, { type: "auth_challenge", nonce: connection.pending.nonce });
  }

  private handleAuthResponse(
    connection: RelayConnection,
    message: RelayClientMessage<"auth_response">,
  ): void {
    const deviceSid = readNonEmptyString(message.device_sid);
    const proof = readNonEmptyString(message.proof);
    const pending = connection.pending;
    if (!deviceSid || !proof) {
      this.sendError(
        connection.socket,
        "WRONG_PARAM",
        "auth_response requires device_sid and proof.",
      );
      return;
    }
    if (!pending) {
      this.sendError(
        connection.socket,
        "WRONG_PARAM",
        "auth_response requires a preceding auth_challenge.",
      );
      return;
    }
    if (deviceSid !== pending.deviceSid) {
      this.sendError(
        connection.socket,
        "WRONG_PARAM",
        "auth_response device_sid does not match the pending challenge.",
      );
      return;
    }

    const device = this.registry.getDevice(pending.deviceSid);
    if (!device) {
      this.sendError(
        connection.socket,
        pending.role === "device" ? "AUTH_FAILED" : "DEVICE_OFFLINE",
        "device_sid is not registered on this relay.",
      );
      return;
    }

    connection.pending = undefined;
    const expected = calculateRelayProof(
      device.passHash,
      pending.nonce,
      pending.role,
      device.deviceSid,
    );
    if (!relayProofEquals(proof, expected)) {
      this.logger?.warn("relay auth proof mismatch", {
        role: pending.role,
        device_sid: device.deviceSid,
      });
      this.sendError(connection.socket, "AUTH_FAILED", "Relay auth proof mismatch.");
      return;
    }

    connection.authenticated = true;
    if (pending.role === "device") {
      device.socket = connection.socket;
      device.authenticated = true;
      connection.deviceSid = device.deviceSid;
      const pairStatus = this.registry.devicePairStatus(device);
      this.send(connection.socket, {
        type: "auth_ack",
        device_sid: device.deviceSid,
        pair_status: pairStatus,
        ...(pairStatus === "matched" ? { terminal_sid: device.terminalSid } : {}),
      });
      this.logger?.info("device authenticated", {
        device_sid: device.deviceSid,
        pair_status: pairStatus,
      });
      return;
    }

    this.authenticateTerminal(connection, device);
  }

  private authenticateTerminal(connection: RelayConnection, device: RelayDeviceRecord): void {
    const terminalSid = `trm_${this.createId()}`;
    const kicked = this.registry.pairTerminal(device, {
      terminalSid,
      deviceSid: device.deviceSid,
      socket: connection.socket,
    });
    if (kicked) {
      // 单 terminal 不变式：旧 terminal 先收到 error 再被断开。
      this.sendError(kicked.socket, "KICKED", "Another terminal paired with this device.");
      this.registry.dropConnection(kicked.socket);
      this.closeSocket(kicked.socket);
      this.logger?.info("terminal kicked", {
        terminal_sid: kicked.terminalSid,
        device_sid: kicked.deviceSid,
      });
    }
    connection.terminalSid = terminalSid;
    // device 当前离线时仍登记 terminal：桌面用持久化 sid 重连后直接恢复 matched，
    // 手机不需要重新扫码。
    const pairStatus: WebRemoteControlRelayPairStatus = this.registry.isDeviceOnline(device)
      ? "matched"
      : "waiting";
    this.send(connection.socket, {
      type: "auth_ack",
      device_sid: device.deviceSid,
      pair_status: pairStatus,
      terminal_sid: terminalSid,
    });
    this.logger?.info("terminal authenticated", {
      device_sid: device.deviceSid,
      terminal_sid: terminalSid,
      pair_status: pairStatus,
    });
  }

  private handlePairStatusQuery(
    connection: RelayConnection,
    message: RelayClientMessage<"pair_status_query">,
  ): void {
    const deviceSid = readNonEmptyString(message.device_sid);
    if (!connection.authenticated || !connection.role || !deviceSid) {
      this.sendError(
        connection.socket,
        "WRONG_PARAM",
        "pair_status_query requires an authenticated connection and device_sid.",
      );
      return;
    }
    if (deviceSid !== connection.deviceSid) {
      // 只允许查询本条连接鉴权时绑定的 device，避免跨设备状态探测。
      this.sendError(
        connection.socket,
        "WRONG_PARAM",
        "pair_status_query device_sid does not match the authenticated connection.",
      );
      return;
    }

    const device = this.registry.getDevice(deviceSid);
    if (!device) {
      this.sendError(
        connection.socket,
        connection.role === "device" ? "AUTH_FAILED" : "DEVICE_OFFLINE",
        "device_sid is not registered on this relay.",
      );
      return;
    }

    if (connection.role === "terminal") {
      const terminal = connection.terminalSid
        ? this.registry.getTerminal(connection.terminalSid)
        : undefined;
      const matched = Boolean(terminal) && this.registry.isDeviceOnline(device);
      const pairStatus: WebRemoteControlRelayPairStatus = matched ? "matched" : "waiting";
      this.send(connection.socket, {
        type: "pair_status_ack",
        pair_status: pairStatus,
        ...(matched && terminal ? { terminal_sid: terminal.terminalSid } : {}),
      });
      return;
    }

    const pairStatus = this.registry.devicePairStatus(device);
    this.send(connection.socket, {
      type: "pair_status_ack",
      pair_status: pairStatus,
      ...(pairStatus === "matched" ? { terminal_sid: device.terminalSid } : {}),
    });
  }

  private rejectFrame(socket: WebRemoteControlRelaySocket, reason: string): void {
    this.logger?.warn("invalid relay frame", { reason });
    this.sendError(socket, "WRONG_PARAM", reason);
  }

  private sendError(
    socket: WebRemoteControlRelaySocket,
    code: WebRemoteControlRelayErrorCode,
    message: string,
  ): void {
    this.logger?.warn("relay error", { code, message });
    this.send(socket, { type: "error", code, message });
  }

  private send(socket: WebRemoteControlRelaySocket, message: WebRemoteControlRelayIncomingMessage) {
    this.trySend(socket, JSON.stringify({ ...message, server_ts: this.now() }));
  }

  private trySend(socket: WebRemoteControlRelaySocket, data: string): boolean {
    try {
      socket.send(data);
      return true;
    } catch (error) {
      this.logger?.warn("relay socket send failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private closeSocket(socket: WebRemoteControlRelaySocket): void {
    try {
      socket.close();
    } catch (error) {
      this.logger?.warn("relay socket close failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
