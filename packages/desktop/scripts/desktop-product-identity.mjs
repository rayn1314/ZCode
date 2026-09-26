/**
 * 构建期开关：为真时安装包使用 Preview 身份，而后端环境仍由 `ZCODE_ENV` 单独决定。
 * 典型用法是 `ZCODE_ENV=production ZCODE_PREVIEW_IDENTITY=1`，得到一个连接生产后端、
 * 可与正式版并排安装的 `ZCode Preview`。
 */
export const ZCODE_PREVIEW_IDENTITY_ENV = "ZCODE_PREVIEW_IDENTITY";

const PRODUCTION_IDENTITY = Object.freeze({
  flavor: "production",
  appId: "dev.zcode.app",
  productName: "ZCode",
  dataRootSuffix: "",
  linuxExecutableName: "zcode",
  linuxPackageName: "zcode",
  cuaHelperInstallVariant: null,
});

const PREVIEW_IDENTITY = Object.freeze({
  flavor: "preview",
  appId: "dev.zcode.app.preview",
  productName: "ZCode Preview",
  dataRootSuffix: "",
  linuxExecutableName: "zcode-preview",
  linuxPackageName: "zcode-preview",
  cuaHelperInstallVariant: "preview",
});

export const desktopProductIdentities = Object.freeze({
  production: PRODUCTION_IDENTITY,
  preview: PREVIEW_IDENTITY,
});

function normalizeDesktopZCodeEnv(env) {
  return env.ZCODE_ENV?.trim().toLowerCase() === "production" ? "production" : "test";
}

/**
 * 开关只有一种开启拼写 `1`（`0` / 空 = 关闭），与 CI workflow 规则和 release 门的
 * `$ZCODE_PREVIEW_IDENTITY == "1"` 精确比较保持同一套语义。其它拼写在构建期直接失败，
 * 避免 `true` 之类在 YAML 路由层漏匹配、却在脚本层被当成开启，把 Preview 包打进生产验收目录。
 */
export function isPreviewIdentityRequested(env = process.env) {
  const value = env[ZCODE_PREVIEW_IDENTITY_ENV]?.trim() ?? "";
  if (value === "1") {
    return true;
  }
  if (value === "" || value === "0") {
    return false;
  }
  throw new Error(
    `invalid ${ZCODE_PREVIEW_IDENTITY_ENV}=${env[ZCODE_PREVIEW_IDENTITY_ENV]}; expected 1 or 0`,
  );
}

/**
 * 产品身份（flavor）与后端环境（`ZCODE_ENV`）是两个轴：
 * - `ZCODE_ENV=test` 一律是 Preview，测试后端不能顶着正式 `ZCode` 身份覆盖用户的正式安装；
 * - `ZCODE_ENV=production` 默认是正式身份，显式 `ZCODE_PREVIEW_IDENTITY=1` 时改用 Preview 身份。
 * 未知 `ZCODE_ENV` 继续按 test 处理，和共享层 normalizeZCodeEnv 的 fail-safe 默认值一致。
 */
export function resolveDesktopProductFlavor(env = process.env) {
  if (isPreviewIdentityRequested(env)) {
    return "preview";
  }
  return normalizeDesktopZCodeEnv(env) === "production" ? "production" : "preview";
}

/**
 * 下游自建客户端的产品身份覆盖开关。
 *
 * 身份表里的 `production` / `preview` 是上游两条发行通道。下游 fork 需要「自己的名字」
 * 才能与官方客户端并排共存（独立安装位、独立 Electron 数据目录、独立 AppUserModelId）。
 * 这里不给身份轴再加第三个 flavor——那会连带改变更新策略、菜单、托盘、CUA Helper 等
 * 所有按 flavor 分支的语义——只覆盖展示身份，flavor 仍按上游规则选择。
 *
 * 用法：`ZCODE_PRODUCT_NAME="ZCode Rayn" ZCODE_APP_ID="dev.zcode.app.rayn" pnpm bundle:desktop -- --win`
 */
export const ZCODE_PRODUCT_NAME_ENV = "ZCODE_PRODUCT_NAME";
export const ZCODE_APP_ID_ENV = "ZCODE_APP_ID";

function readIdentityOverride(env, name) {
  const value = env?.[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Linux 可执行名/包名必须是稳定的小写 slug，否则 electron-builder 会推出 `@zcoderayn` 之类的非法名。 */
function toLinuxSlug(productName) {
  const slug = productName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "zcode";
}

function applyIdentityOverrides(identity, env) {
  const productName = readIdentityOverride(env, ZCODE_PRODUCT_NAME_ENV);
  const appId = readIdentityOverride(env, ZCODE_APP_ID_ENV);
  if (!productName && !appId) {
    return identity;
  }

  const resolvedProductName = productName ?? identity.productName;
  const linuxSlug = toLinuxSlug(resolvedProductName);
  return Object.freeze({
    ...identity,
    productName: resolvedProductName,
    appId: appId ?? identity.appId,
    dataRootSuffix: resolveDataRootSuffix(productName, appId),
    linuxExecutableName: linuxSlug,
    linuxPackageName: linuxSlug,
  });
}

/**
 * 数据根后缀：并排安装的产品身份必须各自独立的数据根。
 *
 * 上游两条官方渠道保持空串，沿用历史数据根 `{dataBaseDir}/.zcode`——上游把
 * 「Preview 与正式版共享任务、配置和凭据」当成设计（见 desktopRuntimeEnv 中
 * ZCODE_CUA_HELPER_INSTALL_VARIANT 的注释），不能替它改语义。
 *
 * 下游自建客户端一旦覆盖产品名或 appId，就说明它要与官方客户端并排运行。此时若仍共用
 * `~/.zcode`，两个客户端会读写同一个会话库（cli/db/db.sqlite）、凭据和设置：会话列表互相
 * 可见，还会并发写同一个 SQLite。所以按覆盖后的身份派生独立后缀。
 */
function resolveDataRootSuffix(productNameOverride, appIdOverride) {
  // appId 末段是下游为自己客户端选定的标识（dev.zcode.app.rayn -> rayn），
  // 比产品名的 slug 短且稳定；只覆盖产品名时退回它。
  const appIdTail = appIdOverride?.split(".").filter(Boolean).pop();
  return `-${toLinuxSlug(appIdTail || productNameOverride || "client")}`;
}

export function resolveDesktopProductIdentityForFlavor(flavor, env = process.env) {
  return applyIdentityOverrides(
    desktopProductIdentities[flavor === "preview" ? "preview" : "production"],
    env,
  );
}

export function resolveDesktopProductIdentity(env = process.env) {
  return resolveDesktopProductIdentityForFlavor(resolveDesktopProductFlavor(env), env);
}

/**
 * 产物文件名后缀标记的是后端环境而不是身份：`_TEST` 只出现在测试后端的安装包上。
 * 生产后端的 Preview 包靠 productName（`ZCode Preview-<version>-...`）与正式包区分。
 */
export function resolveDesktopArtifactSuffix(env = process.env) {
  return normalizeDesktopZCodeEnv(env) === "test" ? "_TEST" : "";
}

/**
 * 返回 Windows Shell 使用的 AppUserModelId。
 *
 * 打包态必须复用 electron-builder 的 appId，否则快捷方式里的 AUMID、开始菜单索引
 * 和运行中的 Electron 进程会被 Windows 视为三个不同的应用。开发态继续保留旧身份，
 * 避免本地调试快捷方式和正式/Preview 安装包互相污染。
 */
export function resolveWindowsAppUserModelIdForFlavor(
  flavor,
  runtime = { isPackaged: true },
  appIdOverride,
) {
  if (runtime.isPackaged === false) {
    return "cn.aminer.zcode";
  }
  // 打包态优先用构建期注入的 appId。下游自建客户端的 appId 覆盖只在构建期可见，
  // 运行时进程环境里没有该变量；若退回身份表，会与安装包注册的 AUMID 不一致，
  // Shell 会把快捷方式、通知和进程当成三个不同应用。
  return appIdOverride?.trim() || resolveDesktopProductIdentityForFlavor(flavor).appId;
}

export function resolveWindowsAppUserModelId(env = process.env, runtime = { isPackaged: true }) {
  return resolveWindowsAppUserModelIdForFlavor(
    resolveDesktopProductFlavor(env),
    runtime,
    resolveDesktopProductIdentity(env).appId,
  );
}
