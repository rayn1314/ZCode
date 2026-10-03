import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { resolveDesktopProductIdentity } from "../../../../../scripts/product-identity.mjs";

const tuiDirectory = resolve(import.meta.dirname, "..");

export async function buildTui() {
  const manifest = JSON.parse(await readFile(resolve(tuiDirectory, "package.json"), "utf8"));
  await build({
    entryPoints: [resolve(tuiDirectory, "src/index.ts")],
    outfile: resolve(tuiDirectory, "dist/index.js"),
    bundle: true,
    define: {
      // 本包把 `@zcode/*` 依赖全部内联（external 只留非 @zcode 的三方包），其中
      // @zcode/contracts 的 config 模块在**求值期**就调用 resolveZCodeDataRoot() 算出数据根。
      // 缺这个 define，内联副本折叠成官方根，而同一进程里的 CLI 用身份根——同一身份出现两套
      // 数据根，后续任何一处（TUI 侧）读它就静默读错。取值与 CLI/桌面/远端 server 同一份来源。
      __ZCODE_DATA_ROOT_SUFFIX__: JSON.stringify(
        resolveDesktopProductIdentity().dataRootSuffix,
      ),
    },
    // Workspace exports can point at TypeScript sources. Compile that closure here;
    // OpenTUI and its native/worker assets must retain their package-relative paths.
    external: Object.keys(manifest.dependencies).filter((name) => !name.startsWith("@zcode/")),
    format: "esm",
    platform: "node",
    target: "node22",
    sourcemap: true,
    logLevel: "info",
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildTui();
}
