import { readFile } from "node:fs/promises";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * ZCode 把自定义供应商的用户命名存在 provider_config.json 里。
 * 这里只读取 providerId/providerName 两个展示字段，绝不读取、存储或输出任何凭据字段。
 * 文件缺失、损坏或结构变化时返回空表，显示名自动退回 id 短名，不影响出数。
 */
export async function loadProviderNames(providerConfigPath: string): Promise<Map<string, string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(providerConfigPath, "utf8"));
  } catch {
    return new Map();
  }
  const rules = (
    parsed as { config?: { providerConfigRules?: { providerRules?: unknown } } } | null
  )?.config?.providerConfigRules?.providerRules;
  if (!Array.isArray(rules)) {
    return new Map();
  }
  const names = new Map<string, string>();
  for (const rule of rules) {
    if (typeof rule !== "object" || rule === null) {
      continue;
    }
    const pid = (rule as { providerId?: unknown }).providerId;
    const name = (rule as { providerName?: unknown }).providerName;
    if (typeof pid === "string" && pid && typeof name === "string" && name) {
      names.set(pid, name);
    }
  }
  // 用户可能给两个供应商起同名，撞名时补 id 短名，否则筛选下拉里无法区分
  const seen = new Map<string, number>();
  for (const name of names.values()) {
    seen.set(name, (seen.get(name) ?? 0) + 1);
  }
  const result = new Map<string, string>();
  for (const [pid, name] of names) {
    result.set(pid, (seen.get(name) ?? 0) > 1 ? `${name} (${pid.slice(0, 8)})` : name);
  }
  return result;
}

/** 没有命名的供应商：UUID 截短 8 位，account:/builtin: 这类渠道名保留全名（截尾会撞名）。 */
export function providerLabel(pid: string | null, names: Map<string, string>): string {
  const name = pid ? names.get(pid) : undefined;
  if (name) {
    return name;
  }
  if (pid && UUID_RE.test(pid)) {
    return pid.slice(0, 8);
  }
  return pid ?? "";
}
