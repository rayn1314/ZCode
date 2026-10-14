/**
 * relay 帧字段读取与日志安全元数据。纯函数，无 I/O。
 *
 * payload 对 relay 是 opaque：这里只提取日志允许记录的三个字段，
 * 其余内容既不解析也不落日志（spec「数据面」节）。
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * 只校验信封形状（type 是非空字符串），不做类型收窄：
 * 调用方需要以 unknown 身份转换为协议联合类型，字段级校验在各 handler 内完成。
 */
export function isRelayEnvelope(value: unknown): boolean {
  return isRecord(value) && typeof value["type"] === "string";
}

export function safePayloadMetadata(payload: unknown): Record<string, string | undefined> {
  if (!isRecord(payload)) {
    return {};
  }
  return {
    zcode_type: typeof payload["zcode_type"] === "string" ? payload["zcode_type"] : undefined,
    requestId: typeof payload["requestId"] === "string" ? payload["requestId"] : undefined,
    bridgeSessionId:
      typeof payload["bridgeSessionId"] === "string" ? payload["bridgeSessionId"] : undefined,
  };
}
