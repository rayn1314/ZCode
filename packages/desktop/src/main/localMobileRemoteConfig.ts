/**
 * 自建 relay 的本地配置文件（`pnpm remote:up` 写入，桌面启动时读取）。
 *
 * 抽成独立模块而非写在 index.ts 里：入口文件无法被测试 import，而这套"只信局域网地址"
 * 的判定是安全边界，必须有测试守着。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface LocalMobileRemoteConfig {
  relayWsUrl?: string;
  remoteUrl?: string;
}

/**
 * 只接受回环/局域网主机；公网域名必须走环境变量。
 *
 * 配置文件落在用户数据目录，理论上可被本机其他程序改写。若允许它指向任意公网主机，
 * 攻击者就能把桌面连到一个伪造 relay，从而截获二维码里的 passHash。因此这里把
 * 可达范围限制在明文 ws/http 的私有网段，VPS 场景让用户显式设环境变量（有意的选择）。
 */
export function isLocalOnlyRemoteControlUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    // 只认明文 ws/http：局域网自托管没有证书，wss/https 会让连接必然失败。
    if (parsed.protocol !== "ws:" && parsed.protocol !== "http:") return false;
    const host = parsed.hostname.replaceAll(/[[\]]/gu, "");
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host.startsWith("127.") ||
      host.startsWith("10.") ||
      host.startsWith("192.168.") ||
      /^172\.(1[6-9]|2\d|3[01])\./u.test(host) ||
      host.startsWith("169.254.") ||
      host.endsWith(".local")
    );
  } catch {
    return false;
  }
}

/**
 * 读 `{dataRootDir}/mobile-remote.json`。
 * 缺文件、JSON 非法、地址不在局域网内，都视为"没有配置"——官方部署行为不变。
 */
export function readLocalMobileRemoteConfig(dataRootDir: string): LocalMobileRemoteConfig | null {
  let raw: string;
  try {
    raw = readFileSync(join(dataRootDir, "mobile-remote.json"), "utf8");
  } catch {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const relayWsUrl = typeof record.relayWsUrl === "string" ? record.relayWsUrl.trim() : "";
    const remoteUrl = typeof record.remoteUrl === "string" ? record.remoteUrl.trim() : "";
    if (relayWsUrl && !isLocalOnlyRemoteControlUrl(relayWsUrl)) return null;
    if (remoteUrl && !isLocalOnlyRemoteControlUrl(remoteUrl)) return null;
    if (!relayWsUrl && !remoteUrl) return null;
    return { relayWsUrl, remoteUrl };
  } catch {
    return null;
  }
}
