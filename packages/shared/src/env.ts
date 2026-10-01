import type { ZCodeRuntimeEnv } from "./runtimeEnv.js";

export type ZCodeEnv = "test" | "production";
/** 安装包身份：决定应用名、app id、Electron 数据目录与更新策略；与后端环境 `ZCodeEnv` 是两个轴。 */
export type ZCodeProductFlavor = "production" | "preview";
export type ArmsRumEnv = "local" | "prod";

// 非构建环境（如 e2e 测试的 mocha）下 define 不存在，用 typeof 检查 + fallback 避免 ReferenceError
declare const __ZCODE_ENV__: string;
declare const __ZCODE_PRODUCT_FLAVOR__: string;

export function normalizeZCodeEnv(value: string | undefined): ZCodeEnv {
  return value?.trim().toLowerCase() === "production" ? "production" : "test";
}

export const ZCODE_ENV = normalizeZCodeEnv(
  typeof __ZCODE_ENV__ !== "undefined" ? __ZCODE_ENV__ : undefined,
);

/**
 * 身份缺省跟随后端环境（test → preview，production → production）。
 * 桌面构建通过 `ZCODE_PREVIEW_IDENTITY=1` 显式注入 preview，得到连接生产后端的 Preview 包；
 * 未注入 define 的 bundle（web、CLI、测试）沿用旧的单轴语义。
 */
export function normalizeZCodeProductFlavor(
  value: string | undefined,
  zcodeEnv: ZCodeEnv,
): ZCodeProductFlavor {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "production" || normalized === "preview") {
    return normalized;
  }
  return zcodeEnv === "production" ? "production" : "preview";
}

export const ZCODE_PRODUCT_FLAVOR = normalizeZCodeProductFlavor(
  typeof __ZCODE_PRODUCT_FLAVOR__ !== "undefined" ? __ZCODE_PRODUCT_FLAVOR__ : undefined,
  ZCODE_ENV,
);

// ── 构建期产品身份（应用名 / appId） ──
// 上游身份表只有 production / preview 两个 flavor。下游 fork 需要自己的应用名与 appId，
// 才能与官方客户端并排共存（独立安装位、独立 Electron 数据目录、独立 AppUserModelId）。
// 构建脚本把**解析后**的身份注入成编译期常量（含下游覆盖，见 desktop-product-identity.mjs），
// 所以这里拿到的是最终值而不是"覆盖开关"。未注入时为空串，调用方回退身份表默认值。
declare const __ZCODE_PRODUCT_NAME__: string;
declare const __ZCODE_APP_ID__: string;
declare const __ZCODE_DATA_ROOT_SUFFIX__: string;

/** 打包态应用名。同时决定 Electron 数据目录与单实例锁，必须与打包身份一致。 */
export const ZCODE_PRODUCT_NAME =
  typeof __ZCODE_PRODUCT_NAME__ !== "undefined" ? __ZCODE_PRODUCT_NAME__.trim() : "";

/** 打包态 appId。必须与安装包注册的 AUMID 一致，否则 Shell 会把快捷方式和进程当成两个应用。 */
export const ZCODE_APP_ID = typeof __ZCODE_APP_ID__ !== "undefined" ? __ZCODE_APP_ID__.trim() : "";

/**
 * 数据根后缀（含前导 `-`），空串表示沿用默认数据根 `{dataBaseDir}/.zcode`。
 *
 * 上游官方渠道为空串；下游自建客户端非空（如 `-rayn` → `~/.zcode-rayn`），
 * 据此与官方客户端并排运行时各用各的会话库、凭据和设置。派生规则见
 * `desktop-product-identity.mjs` 的 resolveDataRootSuffix。
 */
export const ZCODE_DATA_ROOT_SUFFIX =
  typeof __ZCODE_DATA_ROOT_SUFFIX__ !== "undefined" ? __ZCODE_DATA_ROOT_SUFFIX__.trim() : "";
export const ZCODE_APP_VERSION_ENV = "ZCODE_APP_VERSION" as const;
export const ZCODE_BUILD_COMMIT_ID_ENV = "ZCODE_BUILD_COMMIT_ID" as const;
/**
 * 数据根本身的覆盖 env key（完整路径，不再拼 `.zcode`）。
 *
 * 宿主进程与远端部署命令都用它把产品身份定向到各自的数据根；解析规则见
 * services 的 paths.ts（`setDataRootDir > ZCODE_DATA_ROOT > {dataBaseDir}/.zcode`）。
 * 常量放 shared：server 的远端启动命令与 services 的本地 spawn env 必须拼写同源。
 */
export const ZCODE_DATA_ROOT_ENV = "ZCODE_DATA_ROOT" as const;

// ── 运行时环境变量（不经过编译打包，启动时从 process.env 读取） ──
// 启用调试模式，值为 inspect-brk 的端口号，如 ZCODE_DEBUG=9230
export const RUNTIME_ZCODE_DEBUG =
  typeof process !== "undefined" ? process.env.ZCODE_DEBUG : undefined;

// 恢复原因：写死 false 会让运行时已配置的数仓/ARMS 永远空转。
// 功能保持可用；实际出网由各出口的运行时端点检查决定，未配置不上报。
export const ZCODE_TELEMETRY_ENABLED: boolean = true;

/** 数仓事件上报端点：由运行时环境变量提供，未配置即停用，构建产物不内嵌。 */
export const ZCODE_TELEMETRY_REPORT_ENDPOINT =
  typeof process !== "undefined" ? (process.env.ZCODE_TELEMETRY_REPORT_ENDPOINT ?? "") : "";

/** ARMS RUM 接入端点：由运行时环境变量提供，未配置即停用，构建产物不内嵌。 */
export const ZCODE_ARMS_RUM_ENDPOINT =
  typeof process !== "undefined" ? (process.env.ZCODE_ARMS_RUM_ENDPOINT ?? "") : "";

/**
 * 「ARMS RUM 将初始化」的唯一闸门：遥测总开关 + 端点已配置。
 * crash-capture 用同一条件决定是否让远端 SDK 独占崩溃上报；两端条件一旦漂移，
 * 就会出现「以为远端接管了、实际谁都没启动 crashpad」的诊断盲区。
 */
export const ZCODE_ARMS_RUM_ENABLED = ZCODE_TELEMETRY_ENABLED && ZCODE_ARMS_RUM_ENDPOINT !== "";

/** 将本地运行态与编译期 ZCODE_ENV 映射为 ARMS 控制台识别的上报环境标签 */
export function mapZCodeEnvToArmsRumEnv(runtimeEnv: ZCodeRuntimeEnv): ArmsRumEnv {
  return runtimeEnv !== "development" && ZCODE_ENV === "production" ? "prod" : "local";
}
