import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getBootstrapSettingsCandidateFiles } from "@zcode/services/node";

interface ChromiumHardwareAccelerationApp {
  disableHardwareAcceleration(): void;
}

/** 返回 undefined 表示该文件没写这个开关，调用方继续看下一个候选。 */
function extractBootstrapChromiumHardwareAccelerationEnabledOrUndefined(
  rawValue: unknown,
): boolean | undefined {
  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
    return undefined;
  }

  const enabled = (
    rawValue as {
      desktopChromiumHardwareAccelerationEnabled?: unknown;
    }
  ).desktopChromiumHardwareAccelerationEnabled;
  return typeof enabled === "boolean" ? enabled : undefined;
}

export function resolveChromiumHardwareAccelerationSettingsFile(
  homePath: string = homedir(),
): string {
  return join(homePath, ".zcode", "v2", "setting.json");
}

/** 公开判定：未显式写开关时按默认开启处理。 */
export function extractBootstrapChromiumHardwareAccelerationEnabled(rawValue: unknown): boolean {
  return extractBootstrapChromiumHardwareAccelerationEnabledOrUndefined(rawValue) ?? true;
}

/**
 * 读取链：身份文件优先，修复前遗留的官方共享文件兜底（见 paths.getBootstrapSettingsCandidateFiles）。
 * 两个候选都没显式写过开关时保持默认开启。
 */
function readBootstrapChromiumHardwareAccelerationEnabledFromDisk(
  candidates: readonly string[] = getBootstrapSettingsCandidateFiles(),
): boolean {
  for (const settingsFile of candidates) {
    if (!existsSync(settingsFile)) {
      continue;
    }

    try {
      const enabled = extractBootstrapChromiumHardwareAccelerationEnabledOrUndefined(
        JSON.parse(readFileSync(settingsFile, "utf-8")),
      );
      if (enabled !== undefined) {
        return enabled;
      }
    } catch {
      // bootstrap 阶段只读不修：坏文件按“该候选为空”处理，继续看下一个候选。
    }
  }

  return true;
}

export function applyEarlyChromiumHardwareAccelerationBootstrap(
  app: ChromiumHardwareAccelerationApp,
  rawSettings?: unknown,
): boolean {
  // 设置页保存后的二次调用直接吃内存里的设置对象；启动早期则按设置文件读取链解析。
  const enabled =
    rawSettings === undefined
      ? readBootstrapChromiumHardwareAccelerationEnabledFromDisk()
      : extractBootstrapChromiumHardwareAccelerationEnabled(rawSettings);
  if (!enabled) {
    // Electron 只能在 app ready 前关闭 Chromium 硬件加速。
    // 因此设置页保存后必须在下一次 main 进程最早期读取并应用，不能等到 whenReady。
    app.disableHardwareAcceleration();
  }
  return enabled;
}
