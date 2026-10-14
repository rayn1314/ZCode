import type { WebRemoteControlRelayPairStatus, WebRemoteControlRelayRole } from "@zcode/shared";

/**
 * Web 远程控制 relay 的内存注册表：device / terminal / 连接三张表的唯一所有者。
 *
 * 只做簿记与不变式维护，不解析协议、不做网络 I/O；需要断开的旧 socket 由调用方关闭，
 * 以便调用方先下发 error 帧（KICKED）再断开。契约见
 * packages/server/spec/web-remote-control-relay.md「所有权与不变式」。
 */

/** relay 视角的最小 socket 抽象；entry 用 ws 适配，测试用假 socket 驱动。 */
export interface WebRemoteControlRelaySocket {
  send(data: string): void;
  close(): void;
}

export interface WebRemoteControlRelayLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  debug?(message: string, fields?: Record<string, unknown>): void;
}

export interface RelayDeviceRecord {
  deviceSid: string;
  deviceMid: string;
  passHash: string;
  /** 当前连接 socket：注册即写入，鉴权通过后不变；断开时清空但保留条目供重连续用。 */
  socket?: WebRemoteControlRelaySocket;
  /** socket 是否已完成 auth_response；配对与转发都以「已鉴权的 device socket」为准。 */
  authenticated: boolean;
  terminalSid?: string;
}

export interface RelayTerminalRecord {
  terminalSid: string;
  deviceSid: string;
  socket: WebRemoteControlRelaySocket;
}

export interface RelayPendingChallenge {
  nonce: string;
  role: WebRemoteControlRelayRole;
  deviceSid: string;
}

export interface RelayConnection {
  socket: WebRemoteControlRelaySocket;
  role?: WebRemoteControlRelayRole;
  deviceSid?: string;
  terminalSid?: string;
  authenticated: boolean;
  pending?: RelayPendingChallenge;
}

export interface WebRemoteControlRelayRegistryOptions {
  maxDevices: number;
  logger?: WebRemoteControlRelayLogger;
}

export class WebRemoteControlRelayRegistry {
  private readonly devices = new Map<string, RelayDeviceRecord>();
  private readonly terminals = new Map<string, RelayTerminalRecord>();
  private readonly connections = new Map<WebRemoteControlRelaySocket, RelayConnection>();
  private readonly maxDevices: number;
  private readonly logger?: WebRemoteControlRelayLogger;

  constructor(options: WebRemoteControlRelayRegistryOptions) {
    this.maxDevices = Math.max(1, Math.floor(options.maxDevices));
    this.logger = options.logger;
  }

  attach(socket: WebRemoteControlRelaySocket): void {
    this.connections.set(socket, { socket, authenticated: false });
  }

  getConnection(socket: WebRemoteControlRelaySocket): RelayConnection | undefined {
    return this.connections.get(socket);
  }

  dropConnection(socket: WebRemoteControlRelaySocket): void {
    this.connections.delete(socket);
  }

  /** socket 关闭后的簿记：一端断开即把另一端置为可重新配对状态。 */
  detach(socket: WebRemoteControlRelaySocket): void {
    const connection = this.connections.get(socket);
    if (!connection) {
      return;
    }
    this.connections.delete(socket);

    if (connection.role === "device" && connection.deviceSid) {
      const device = this.devices.get(connection.deviceSid);
      if (device?.socket === socket) {
        // 保留注册条目与配对记录：桌面用持久化 device_sid 重连即可恢复 matched，
        // 不迫使手机重新扫码；条目在容量不足时由 pruneDisconnectedDevices 回收。
        device.socket = undefined;
        device.authenticated = false;
        this.logger?.info("device disconnected", {
          device_sid: device.deviceSid,
          keeps_pairing: Boolean(device.terminalSid),
        });
      }
      return;
    }

    if (connection.role === "terminal" && connection.terminalSid) {
      this.unregisterTerminal(connection.terminalSid);
      this.logger?.info("terminal disconnected", {
        terminal_sid: connection.terminalSid,
        device_sid: connection.deviceSid,
      });
      return;
    }
    this.logger?.debug?.("relay connection closed", {
      role: connection.role,
      authenticated: connection.authenticated,
    });
  }

  getDevice(deviceSid: string): RelayDeviceRecord | undefined {
    return this.devices.get(deviceSid);
  }

  getTerminal(terminalSid: string): RelayTerminalRecord | undefined {
    return this.terminals.get(terminalSid);
  }

  findDeviceByMid(deviceMid: string): RelayDeviceRecord | undefined {
    for (const device of this.devices.values()) {
      if (device.deviceMid === deviceMid) {
        return device;
      }
    }
    return undefined;
  }

  /** 容量检查：同一 device_mid 重复注册是替换、不新增槽位；超限时先回收瞬断条目。 */
  reserveDeviceSlot(deviceMid: string): boolean {
    if (this.findDeviceByMid(deviceMid)) {
      return true;
    }
    if (this.devices.size < this.maxDevices) {
      return true;
    }
    this.pruneDisconnectedDevices();
    return this.devices.size < this.maxDevices;
  }

  addDevice(device: RelayDeviceRecord): void {
    this.devices.set(device.deviceSid, device);
  }

  /** 同 device_mid 重复注册：作废登记与配对记录，返回需要断开的旧 socket。 */
  retireDevice(
    device: RelayDeviceRecord,
    keepSocket: WebRemoteControlRelaySocket,
  ): WebRemoteControlRelaySocket | undefined {
    if (device.terminalSid) {
      this.terminals.delete(device.terminalSid);
    }
    const staleSocket = device.socket;
    this.devices.delete(device.deviceSid);
    this.logger?.info("device registration retired", {
      device_sid: device.deviceSid,
      device_mid: device.deviceMid,
    });
    if (!staleSocket || staleSocket === keepSocket) {
      return undefined;
    }
    this.connections.delete(staleSocket);
    return staleSocket;
  }

  /** 同一 device 用新 socket 鉴权（半开重连）：旧 socket 失效，登记条目保留。 */
  displaceDeviceSocket(
    device: RelayDeviceRecord,
    nextSocket: WebRemoteControlRelaySocket,
  ): WebRemoteControlRelaySocket | undefined {
    const staleSocket = device.socket;
    if (!staleSocket || staleSocket === nextSocket) {
      return undefined;
    }
    // 新 socket 尚未通过 proof 校验，期间该 device 视为离线：terminal 侧报 waiting，
    // data 得到 INTERNAL，与官方 relay 在桌面重连窗口内的表现一致。
    device.socket = undefined;
    device.authenticated = false;
    this.connections.delete(staleSocket);
    this.logger?.info("device socket displaced", { device_sid: device.deviceSid });
    return staleSocket;
  }

  /** 登记 terminal 配对；已被其他 terminal 占用时返回旧 terminal，由调用方下发 KICKED。 */
  pairTerminal(
    device: RelayDeviceRecord,
    terminal: RelayTerminalRecord,
  ): RelayTerminalRecord | undefined {
    const previousSid = device.terminalSid;
    const previous = previousSid ? this.terminals.get(previousSid) : undefined;
    this.terminals.set(terminal.terminalSid, terminal);
    device.terminalSid = terminal.terminalSid;
    if (previous && previous.socket !== terminal.socket) {
      this.unregisterTerminal(previous.terminalSid);
      return previous;
    }
    return undefined;
  }

  unregisterTerminal(terminalSid: string): void {
    const terminal = this.terminals.get(terminalSid);
    this.terminals.delete(terminalSid);
    if (!terminal) {
      return;
    }
    const device = this.devices.get(terminal.deviceSid);
    if (device?.terminalSid === terminalSid) {
      device.terminalSid = undefined;
    }
  }

  devicePairStatus(device: RelayDeviceRecord): WebRemoteControlRelayPairStatus {
    return device.terminalSid && this.terminals.has(device.terminalSid) ? "matched" : "waiting";
  }

  /** device 是否有已鉴权的活跃 socket；terminal 的 matched 与 data 转发都以它为准。 */
  isDeviceOnline(device: RelayDeviceRecord | undefined): boolean {
    return Boolean(device?.socket && device.authenticated);
  }

  /**
   * 回收已断开且没有手机在等的 device 条目；容量耗尽时再回收挂着等待 terminal 的条目。
   * 没有这一步，瞬断后保留的条目会把设备数上限的槽位永久占满。
   */
  private pruneDisconnectedDevices(): void {
    for (const [deviceSid, device] of this.devices) {
      if (device.socket) {
        continue;
      }
      if (device.terminalSid && this.terminals.has(device.terminalSid)) {
        continue;
      }
      this.devices.delete(deviceSid);
    }
    for (const [deviceSid, device] of this.devices) {
      if (this.devices.size < this.maxDevices) {
        return;
      }
      if (device.socket) {
        continue;
      }
      if (device.terminalSid) {
        this.terminals.delete(device.terminalSid);
      }
      this.devices.delete(deviceSid);
    }
  }
}
