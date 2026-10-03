// 构建期产品身份（product-identity.mjs）的类型声明。
//
// 与 packages/desktop/scripts/target-platform.d.mts 同一套做法：构建脚本本身是 .mjs，
// 但被 TS 源码直接 import（如 desktop main 的 AppUserModelId、build-remote.ts 的远端后缀），
// 没有声明文件时 tsc 会报 TS7016（隐式 any）。声明只覆盖对外公开面，新增导出需同步这里。

export type DesktopProductFlavor = "production" | "preview";

export interface DesktopProductIdentity {
  flavor: DesktopProductFlavor;
  appId: string;
  productName: string;
  /** 数据根后缀（含前导 `-`）；上游官方渠道为空串。 */
  dataRootSuffix: string;
  linuxExecutableName: string;
  linuxPackageName: string;
  cuaHelperInstallVariant: string | null;
}

export type ProductIdentityEnv = Record<string, string | undefined>;

export const ZCODE_PREVIEW_IDENTITY_ENV: string;
export const ZCODE_PRODUCT_NAME_ENV: string;
export const ZCODE_APP_ID_ENV: string;

export const desktopProductIdentities: Readonly<
  Record<"production" | "preview", DesktopProductIdentity>
>;

export function isPreviewIdentityRequested(env?: ProductIdentityEnv): boolean;
export function resolveDesktopProductFlavor(env?: ProductIdentityEnv): DesktopProductFlavor;
export function resolveDesktopProductIdentityForFlavor(
  flavor: DesktopProductFlavor,
  env?: ProductIdentityEnv,
): DesktopProductIdentity;
export function resolveDesktopProductIdentity(env?: ProductIdentityEnv): DesktopProductIdentity;
export function resolveDesktopArtifactSuffix(env?: ProductIdentityEnv): string;
export function resolveWindowsAppUserModelIdForFlavor(
  flavor: DesktopProductFlavor,
  runtime?: { isPackaged: boolean },
  appIdOverride?: string,
): string;
export function resolveWindowsAppUserModelId(
  env?: ProductIdentityEnv,
  runtime?: { isPackaged: boolean },
): string;
