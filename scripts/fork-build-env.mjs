// Fork 自建版构建的固有环境默认值（env 可覆盖，不影响上游风格构建）。
//
// 为什么整条链都要设置：数据根身份后缀是构建期 define——
// packages/desktop/tsup.config.ts 把 resolveDesktopProductIdentity() 的
// dataRootSuffix 烤成 __ZCODE_DATA_ROOT_SUFFIX__。只给 electron-builder 设
// 身份不够，bootstrap 里的桌面端 bundle 构建同样要带，否则打出来的包数据根
// 落在官方 ~/.zcode，与官方客户端串数据。
import process from "node:process";

export function applyForkBuildEnvDefaults(env = process.env) {
  // 独立产品名/AppId 换来独立安装位与 Electron 数据目录，与官方客户端并排共存；
  env.ZCODE_PRODUCT_NAME ||= "ZCode Rayn";
  env.ZCODE_APP_ID ||= "dev.zcode.app.rayn";
  // preview 身份让自建包不参与官方的强制更新链路，不会被官方包覆盖回去；
  env.ZCODE_PREVIEW_IDENTITY ||= "1";
  // production 后端连同一套线上服务，不需要自建后端；
  env.ZCODE_ENV ||= "production";
  // 本机没有代码签名证书，关掉自动探测，避免 electron-builder 去找证书；
  env.CSC_IDENTITY_AUTO_DISCOVERY ||= "false";
  env.ELECTRON_MIRROR ||= "https://npmmirror.com/mirrors/electron/";
  return env;
}
