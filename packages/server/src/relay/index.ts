/**
 * @zcode/server/relay 公开入口：Web 远程控制中转服务的可复用实现。
 *
 * 只暴露「能力」与「类型」，不暴露内部文件路径，便于桌面进程内托管与独立部署共用同一份逻辑：
 * - entry-relay.ts（命令行 / 独立进程 / VPS）
 * - packages/desktop/src/main/webRemoteControlRelayHost.ts（桌面进程内托管，局域网默认路径）
 *
 * 注意：本入口只被 Node 侧消费，不进入浏览器包。
 */

export {
  createWebRemoteControlRelayHttpServer,
  createRelayConsoleLogger,
  createSilentRelayLogger,
  rawDataByteLength,
  rawDataToText,
  RELAY_DEFAULT_MAX_DEVICES,
  type WebRemoteControlRelayHttpServerConfig,
  type WebRemoteControlRelayHttpServerHandle,
} from "./relayHttpServer.js";

export {
  listLanHostCandidates,
  resolveLanHostAddress,
  isPrivateIpv4,
  type LanHostCandidate,
} from "./lanHost.js";

export {
  WebRemoteControlRelayHub,
  type WebRemoteControlRelayLogger,
  type WebRemoteControlRelaySocket,
} from "./webRemoteControlRelayHub.js";

export {
  createRelayPassword,
  createRelayPassHash,
  calculateRelayProof,
  relayProofEquals,
} from "./relayAuth.js";
