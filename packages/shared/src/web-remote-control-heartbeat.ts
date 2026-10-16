export const WEB_REMOTE_CONTROL_HEARTBEAT_INTERVAL_MS = 10_000;
export const WEB_REMOTE_CONTROL_HEARTBEAT_JITTER_MS = 2_000;
export const WEB_REMOTE_CONTROL_HEARTBEAT_ACK_TIMEOUT_MS = 30_000;
export const WEB_REMOTE_CONTROL_RECONNECT_JITTER_MS = 2_000;
/**
 * 从未成功连上 relay 时的最大连接尝试次数。
 *
 * relay 未启动、地址配错、防火墙拦截这三种情况重试再多次也不会成功；若沿用
 * 「已配对会话」的无限重连，这些致命错误会被反复洗成"启动中"，用户既等不到二维码，
 * 也看不到真实原因（ECONNREFUSED 只闪现 1 秒就被下一次 connecting 覆盖）。
 * 达到上限后停在 error，把原因和处置动作交给用户；一旦 TCP 连上过一次就不再受限
 * （relay 短抖动仍走既有的无限重连，保证手机拿旧二维码回来能恢复）。
 */
export const WEB_REMOTE_CONTROL_MAX_INITIAL_CONNECT_ATTEMPTS = 6;

function safeRandom(random: () => number): number {
  const value = random();
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(0.999999999, Math.max(0, value));
}

export function getWebRemoteControlHeartbeatJitterMs(
  baseIntervalMs = WEB_REMOTE_CONTROL_HEARTBEAT_INTERVAL_MS,
  configuredJitterMs?: number,
): number {
  const normalizedBase =
    Number.isFinite(baseIntervalMs) && baseIntervalMs > 0
      ? Math.floor(baseIntervalMs)
      : WEB_REMOTE_CONTROL_HEARTBEAT_INTERVAL_MS;
  const defaultJitterMs = Math.min(
    WEB_REMOTE_CONTROL_HEARTBEAT_JITTER_MS,
    Math.floor(normalizedBase * 0.2),
  );
  const requestedJitterMs = configuredJitterMs ?? defaultJitterMs;
  if (!Number.isFinite(requestedJitterMs) || requestedJitterMs <= 0) {
    return 0;
  }
  // 心跳 jitter 必须小于基准间隔，避免把合法的 transport heartbeat 变成 0ms 风暴。
  return Math.min(Math.floor(requestedJitterMs), Math.max(0, normalizedBase - 1));
}

export function getWebRemoteControlHeartbeatDelayMs(
  baseIntervalMs = WEB_REMOTE_CONTROL_HEARTBEAT_INTERVAL_MS,
  configuredJitterMs?: number,
  random: () => number = Math.random,
): number {
  const normalizedBase =
    Number.isFinite(baseIntervalMs) && baseIntervalMs > 0
      ? Math.floor(baseIntervalMs)
      : WEB_REMOTE_CONTROL_HEARTBEAT_INTERVAL_MS;
  const jitterMs = getWebRemoteControlHeartbeatJitterMs(normalizedBase, configuredJitterMs);
  const minDelayMs = Math.max(1, normalizedBase - jitterMs);
  const maxDelayMs = normalizedBase + jitterMs;
  return minDelayMs + Math.floor(safeRandom(random) * (maxDelayMs - minDelayMs + 1));
}

export function getWebRemoteControlReconnectJitterMs(
  configuredJitterMs = WEB_REMOTE_CONTROL_RECONNECT_JITTER_MS,
  random: () => number = Math.random,
): number {
  if (!Number.isFinite(configuredJitterMs) || configuredJitterMs <= 0) {
    return 0;
  }
  const maxJitterMs = Math.floor(configuredJitterMs);
  return Math.floor(safeRandom(random) * (maxJitterMs + 1));
}
