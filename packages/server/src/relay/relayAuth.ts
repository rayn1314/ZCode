import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { WebRemoteControlRelayRole } from "@zcode/shared";

/**
 * relay 鉴权原语。必须与桌面端
 * `packages/desktop/src/main/webRemoteControlRelayAuthProvider.ts` 逐位一致：
 * 任何编码 / 摘要 / 消息拼写差异都会让桌面与手机在 auth_response 阶段 AUTH_FAILED。
 */

/** 仅测试与部署工具使用；relay 自身不生成 password，password 只存在于二维码 URL 与桌面凭据服务。 */
export function createRelayPassword(): string {
  return randomBytes(24).toString("base64url");
}

export function createRelayPassHash(password: string): string {
  return createHash("sha256").update(password).digest("base64");
}

export function calculateRelayProof(
  passHash: string,
  nonce: string,
  role: WebRemoteControlRelayRole,
  deviceSid: string,
): string {
  return createHmac("sha256", passHash).update(`${nonce}|${role}|${deviceSid}`).digest("base64url");
}

/**
 * 常量时间比较 proof。两者都是 32 字节 HMAC 的 base64url（定长 43），
 * 长度不等时直接判否，不进入 timingSafeEqual（它要求等长缓冲）。
 */
export function relayProofEquals(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(actualBuffer, expectedBuffer);
}
