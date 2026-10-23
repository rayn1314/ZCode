import {
  ZCODE_AGENT_CA_CERT_ENV_KEY,
  ZCODE_HTTP_PROXY_ENV_KEY,
  ZCODE_NO_PROXY_ENV_KEY,
  ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY,
  readZCodeToolEnvPassthroughEnv,
} from "@zcode/shared";

export interface NetworkEgressEnvPolicy {
  caCertFile?: string;
  httpProxy?: string;
  noProxy?: string;
}

interface NetworkEgressEnvOptions {
  network?: NetworkEgressEnvPolicy;
  platform?: NodeJS.Platform;
  sourceEnv?: Record<string, string | undefined>;
  toolEnvPassthrough?: boolean;
}

const ALL_PROXY_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;
const NO_PROXY_KEYS = ["NO_PROXY", "no_proxy"] as const;
const CA_SOURCE_KEYS = [
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
] as const;
const CA_TARGET_KEYS = CA_SOURCE_KEYS;
const EXPLICIT_CA_SOURCE_KEYS = [ZCODE_AGENT_CA_CERT_ENV_KEY] as const;
const EXPLICIT_NO_PROXY_SOURCE_KEYS = [ZCODE_NO_PROXY_ENV_KEY] as const;

export function applyNetworkEgressEnv(
  env: Record<string, string>,
  options: NetworkEgressEnvOptions,
): Record<string, string> {
  const platform = options.platform ?? process.platform;
  const sourceEnv = options.sourceEnv ?? {};
  const network = options.network ?? {};

  deleteEnvKey(env, ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY, platform);
  if (options.toolEnvPassthrough !== false) {
    applyToolEnvPassthroughEnv(env, sourceEnv, platform);
  }
  applyProxyEnv(env, sourceEnv, network, platform);
  applyNoProxyEnv(env, sourceEnv, network, platform);
  applyCaEnv(env, sourceEnv, network, platform);
  return env;
}

function applyToolEnvPassthroughEnv(
  env: Record<string, string>,
  sourceEnv: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): void {
  const passthroughEnv = readZCodeToolEnvPassthroughEnv(sourceEnv);
  for (const [key, value] of Object.entries(passthroughEnv)) {
    setEnvKey(env, key, value, platform);
  }
}

function applyProxyEnv(
  env: Record<string, string>,
  sourceEnv: Record<string, string | undefined>,
  network: NetworkEgressEnvPolicy,
  platform: NodeJS.Platform,
): void {
  const configuredProxy = normalizeProxyValue(network.httpProxy);
  if (configuredProxy) {
    setEnvKeys(env, ALL_PROXY_KEYS, configuredProxy, platform);
    return;
  }

  const zcodeProxy = normalizeProxyValue(
    getFirstEnvValue(sourceEnv, [ZCODE_HTTP_PROXY_ENV_KEY], platform),
  );
  if (zcodeProxy) {
    setEnvKeys(env, ALL_PROXY_KEYS, zcodeProxy, platform);
    return;
  }
}

function applyNoProxyEnv(
  env: Record<string, string>,
  sourceEnv: Record<string, string | undefined>,
  network: NetworkEgressEnvPolicy,
  platform: NodeJS.Platform,
): void {
  const noProxy =
    normalizeEnvValue(network.noProxy) ??
    getFirstEnvValue(sourceEnv, EXPLICIT_NO_PROXY_SOURCE_KEYS, platform);
  if (!noProxy) {
    return;
  }
  setEnvKeys(env, NO_PROXY_KEYS, noProxy, platform);
}

function applyCaEnv(
  env: Record<string, string>,
  sourceEnv: Record<string, string | undefined>,
  network: NetworkEgressEnvPolicy,
  platform: NodeJS.Platform,
): void {
  const caCertFile =
    normalizeEnvValue(network.caCertFile) ??
    getFirstEnvValue(sourceEnv, EXPLICIT_CA_SOURCE_KEYS, platform);
  if (!caCertFile) {
    return;
  }
  setEnvKeys(env, CA_TARGET_KEYS, caCertFile, platform);
}

function normalizeProxyValue(value: string | undefined): string | undefined {
  const trimmed = normalizeEnvValue(value);
  if (!trimmed) {
    return undefined;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `http://${trimmed}`;
}

function normalizeEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function getFirstEnvValue(
  env: Record<string, string | undefined>,
  keys: readonly string[],
  platform: NodeJS.Platform,
): string | undefined {
  for (const key of keys) {
    const value = getEnvValue(env, key, platform);
    if (normalizeEnvValue(value)) {
      return value;
    }
  }
  return undefined;
}

function setEnvKey(
  env: Record<string, string>,
  key: string,
  value: string,
  platform: NodeJS.Platform,
): void {
  deleteEnvKey(env, key, platform);
  env[key] = value;
}

/**
 * 写入同一逻辑变量的多个大小写变体（HTTP_PROXY/http_proxy 等）。
 *
 * Windows 上 `setEnvKey` 的删除逻辑大小写不敏感，逐个写入会让后写的变体把先写的删掉，
 * 子进程最终只剩一种拼写；而不同工具只认其中一种。这里先统一清掉目标键的全部大小写变体，
 * 再一次性写入所有拼写，既避免旧值残留，也保留双拼写。
 */
function setEnvKeys(
  env: Record<string, string>,
  keys: readonly string[],
  value: string,
  platform: NodeJS.Platform,
): void {
  if (platform !== "win32") {
    for (const key of keys) env[key] = value;
    return;
  }

  const targetKeys = new Set(keys.map((key) => key.toLowerCase()));
  for (const existingKey of Object.keys(env)) {
    if (targetKeys.has(existingKey.toLowerCase())) {
      delete env[existingKey];
    }
  }
  for (const key of keys) env[key] = value;
}

function deleteEnvKey(env: Record<string, string>, key: string, platform: NodeJS.Platform): void {
  if (platform !== "win32") {
    delete env[key];
    return;
  }

  const lowerKey = key.toLowerCase();
  for (const existingKey of Object.keys(env)) {
    if (existingKey.toLowerCase() === lowerKey) {
      delete env[existingKey];
    }
  }
}

function getEnvValue(
  env: Record<string, string | undefined>,
  key: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== "win32") {
    return env[key];
  }
  const lowerKey = key.toLowerCase();
  const actualKey = Object.keys(env).find((candidate) => candidate.toLowerCase() === lowerKey);
  return actualKey ? env[actualKey] : undefined;
}
