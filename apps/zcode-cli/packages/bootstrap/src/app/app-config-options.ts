import { resolvePath, type ConfigResult } from "@zcode/adapters/config";
import { createNodeSessionMailboxAdapter } from "@zcode/adapters/mailbox";
import { detectLocale, resolveLocale } from "@zcode/i18n";
import {
  DEFAULT_SESSION_MAILBOX_ROOT,
  SESSION_MAILBOX_ROOT_ENV,
} from "@zcode/shared";
import type {
  RuntimeConfigPatch,
  SessionMailboxPort,
  SupportedLocale,
  UiLocale,
} from "@zcode/contracts";
import type { ZCodeAppOptions } from "./types.js";

/** 显式关闭值：只有 0/false（大小写、空白容忍）才关；未设置一律视为开启。 */
const MESSAGE_DISABLED_VALUES = new Set(["0", "false"]);

/**
 * 消息与 mailbox 能力默认开启（spec 阶段 3）：`ZCODE_MESSAGE_ENABLED` 不再需要显式置 1，
 * 只有显式设为 `0`/`false` 才关闭，用于排障与灰度回退。
 */
export function isMessageEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.ZCODE_MESSAGE_ENABLED?.trim().toLowerCase();
  return raw === undefined || !MESSAGE_DISABLED_VALUES.has(raw);
}

/**
 * 按开关解析 mailbox 适配器。关闭时返回 undefined，调用方据此把端口与收件箱一并缺席；
 * 开启时统一在此解析 root，app 侧收件箱与进程级投递端口共用同一棵目录树。
 */
export function createSessionMailboxPortFromEnv(
  env: NodeJS.ProcessEnv,
): SessionMailboxPort | undefined {
  if (!isMessageEnabled(env)) return undefined;
  return createNodeSessionMailboxAdapter({
    rootDir: resolvePath(env[SESSION_MAILBOX_ROOT_ENV] ?? DEFAULT_SESSION_MAILBOX_ROOT),
  });
}

export function createConfigCliOverrides(options: ZCodeAppOptions): RuntimeConfigPatch | undefined {
  const overrides: RuntimeConfigPatch = {};
  const permission: NonNullable<RuntimeConfigPatch["permission"]> = {};

  if (options.runtimeConfig?.mode) {
    permission.mode = options.runtimeConfig.mode;
  }
  if (options.runtimeConfig?.toolAllowlist) {
    permission.allowedTools = [...options.runtimeConfig.toolAllowlist];
  }
  if (options.runtimeConfig?.toolDisallowlist) {
    // headless CLI 的 denylist 同时投影到 permission config，让执行期权限
    // 路径与 provider-visible 工具面共享同一份禁用清单。
    permission.disallowedTools = [...options.runtimeConfig.toolDisallowlist];
  }
  if (Object.keys(permission).length > 0) {
    overrides.permission = permission;
  }
  if (options.uiLocale) {
    overrides.ui = {
      locale: options.uiLocale,
    };
  }

  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

export function resolveEffectiveConfigResult(
  configResult: ConfigResult,
  options: ZCodeAppOptions,
): ConfigResult {
  const requestedLocale = configResult.config.ui.locale;
  const effectiveLocale = resolveEffectiveLocale(requestedLocale, options);

  if (effectiveLocale === requestedLocale) {
    return configResult;
  }

  return {
    ...configResult,
    config: {
      ...configResult.config,
      ui: {
        ...configResult.config.ui,
        locale: effectiveLocale,
      },
    },
  };
}

export function resolveEffectiveLocale(
  requestedLocale: UiLocale,
  options: ZCodeAppOptions,
): SupportedLocale {
  const detectedLocale = requestedLocale === "auto" ? detectAppLocale(options) : undefined;
  return resolveLocale(requestedLocale, detectedLocale);
}

function detectAppLocale(options: ZCodeAppOptions): SupportedLocale | undefined {
  if (options.uiDetectedLocale !== undefined) {
    return detectLocale({
      intlLocale: options.uiDetectedLocale,
    });
  }

  return detectLocale({
    env: options.env ?? process.env,
    intlLocale: resolveIntlLocale(),
  });
}

function resolveIntlLocale(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return undefined;
  }
}
