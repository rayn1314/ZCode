import { networkInterfaces } from "node:os";

/**
 * 局域网可达地址解析：给桌面进程内托管的 relay 决定绑定哪个网卡。
 *
 * 安全取向：默认只接受私网地址（RFC1918 + 链路本地），绝不因为"探测不到合适的私网"
 * 就退回到 0.0.0.0——那样会把中转服务顺带暴露到机器上任何公网/虚拟网卡上，
 * 与"不进公网"的默认约束冲突。探测不到时宁可报错，让用户显式放行。
 */

export interface LanHostCandidate {
  address: string;
  virtual: boolean;
  name: string;
}

const VIRTUAL_NIC_NAME = /^(vmnet|vboxnet|veth|docker|br-|utun|tailscale|wsl|hyper-v)/i;
const PRIVATE_IPV4 =
  /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

export function isPrivateIpv4(address: string): boolean {
  return PRIVATE_IPV4.test(address);
}

/** 常见家用/办公网段优先，减少在多网卡机器上选错的可能。 */
function score(address: string): number {
  if (address.startsWith("192.168.")) return 0;
  if (address.startsWith("10.")) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 2;
  return 3;
}

/** 列出本机非回环 IPv4；VMware/VirtualBox 等虚拟网卡排最后。 */
export function listLanHostCandidates(): LanHostCandidate[] {
  const candidates: LanHostCandidate[] = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal) continue;
      candidates.push({ address: address.address, virtual: VIRTUAL_NIC_NAME.test(name), name });
    }
  }
  const preferred = candidates.filter((item) => !item.virtual);
  const ordered = preferred.length > 0 ? preferred : candidates;
  ordered.sort((a, b) => score(a.address) - score(b.address));
  return ordered;
}

/**
 * 取用于绑定 relay 的地址：私网 IPv4 优先，探测不到则 undefined（调用方应报错而非回退全网卡）。
 */
export function resolveLanHostAddress(): string | undefined {
  return listLanHostCandidates()
    .filter((candidate) => isPrivateIpv4(candidate.address))
    .at(0)?.address;
}
