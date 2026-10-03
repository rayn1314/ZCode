import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolveZCodeEndpointOrigin, pickProductEndpointEnv } from "@zcode/shared/zcodeEndpoint";
import { pdfJsCMapsPlugin } from "../ui/vite/pdfJsCMapsPlugin.js";
import { getBuildMetadata } from "./scripts/build-metadata.mjs";
import {
  resolveDesktopProductFlavor,
  resolveDesktopProductIdentityForFlavor,
} from "../../scripts/product-identity.mjs";

const buildMetadata = getBuildMetadata();
const desktopRequire = createRequire(import.meta.url);

interface IstanbulInstrumenter {
  instrumentSync(sourceCode: string, filename: string): string;
  lastFileCoverage(): unknown;
  lastSourceMap(): object | null;
}

interface IstanbulLibInstrument {
  createInstrumenter(options: {
    autoWrap: boolean;
    compact: boolean;
    coverageGlobalScope: string;
    coverageGlobalScopeFunc: boolean;
    esModules: boolean;
    parserPlugins: string[];
    preserveComments: boolean;
    produceSourceMap: boolean;
  }): IstanbulInstrumenter;
}

const { createInstrumenter } = desktopRequire("istanbul-lib-instrument") as IstanbulLibInstrument;

function resolveInstalledPackageRoot(packageName: string): string {
  return dirname(desktopRequire.resolve(`${packageName}/package.json`));
}

export const desktopRendererDependencyAliases = {
  // pnpm hoisted/package-local 布局会随安装配置变化；硬编码 node_modules 子路径
  // 会让 Rolldown 依赖优化把 react/jsx-runtime 等入口解析到不存在的位置。
  // 通过 Node 解析真实安装根目录，既保留单 React runtime，又兼容不同 node-linker。
  react: resolveInstalledPackageRoot("react"),
  "react-dom": resolveInstalledPackageRoot("react-dom"),
  "lucide-react": resolveInstalledPackageRoot("lucide-react"),
} as const;

function resolveZCodeEnv(value: string | undefined): "test" | "production" {
  return value?.trim().toLowerCase() === "production" ? "production" : "test";
}

function createE2EUIRendererCoveragePlugin(repoRoot: string): Plugin {
  const sourceRoots = [
    resolve(repoRoot, "packages/ui/src"),
    resolve(repoRoot, "packages/desktop/src/renderer"),
  ].map(normalizePathForVite);
  const instrumenter = createInstrumenter({
    autoWrap: true,
    compact: false,
    coverageGlobalScope: "globalThis",
    coverageGlobalScopeFunc: false,
    esModules: true,
    parserPlugins: ["typescript", "jsx"],
    preserveComments: true,
    produceSourceMap: true,
  });
  const baselineCoverage: Record<string, unknown> = {};
  const baselinePath = resolve(
    repoRoot,
    "packages/desktop/out/renderer/e2e-coverage-baseline.json",
  );

  return {
    name: "zcode:e2e-ui-source-coverage",
    enforce: "pre",
    transform(sourceCode, id, options) {
      if (options?.ssr || id.startsWith("\0")) {
        return null;
      }
      const filename = stripViteRequestQuery(id);
      const absoluteFilename = isAbsolute(filename) ? filename : resolve(repoRoot, filename);
      const normalizedFilename = normalizePathForVite(absoluteFilename);
      if (!shouldInstrumentE2EUISource(normalizedFilename, sourceRoots)) {
        return null;
      }

      // post-transform 插桩依赖 Vite/React/esbuild 的合并 sourcemap，
      // 会把生成后的 JS 覆盖点反投影到 import、interface 等 TS 源码行上。
      // 这里先对原始 TS/TSX AST 插桩，再交给 Vite 编译，保证 coverage map 只包含真实运行时代码。
      const code = instrumenter.instrumentSync(sourceCode, normalizedFilename);
      baselineCoverage[normalizedFilename] = JSON.parse(
        JSON.stringify(instrumenter.lastFileCoverage()),
      );
      return {
        code,
        map: instrumenter.lastSourceMap(),
      };
    },
    closeBundle() {
      // 只读取页面 __coverage__ 会让从未加载的 lazy chunk 消失，分母被缩小。
      // coverage build 将完整 renderer graph 的零命中 map 留给 suite reporter 合并。
      mkdirSync(dirname(baselinePath), { recursive: true });
      writeFileSync(baselinePath, `${JSON.stringify(baselineCoverage, null, 2)}\n`, "utf-8");
    },
  };
}

function shouldInstrumentE2EUISource(filename: string, sourceRoots: string[]) {
  return (
    isCoverageSourceFile(filename) &&
    !filename.includes("/node_modules/") &&
    !isDeclarationFile(filename) &&
    !isTestSourceFile(filename) &&
    sourceRoots.some((sourceRoot) => isInsidePath(filename, sourceRoot))
  );
}

function isCoverageSourceFile(filename: string) {
  return [".cts", ".cjs", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"].includes(extname(filename));
}

function isDeclarationFile(filename: string) {
  return /\.d\.[cm]?ts$/u.test(filename);
}

function isTestSourceFile(filename: string) {
  return /\.(?:spec|test)\.[cm]?[jt]sx?$/u.test(filename);
}

function isInsidePath(filename: string, directory: string) {
  return filename === directory || filename.startsWith(`${directory}/`);
}

function normalizePathForVite(path: string) {
  return path.replaceAll("\\", "/");
}

function stripViteRequestQuery(id: string) {
  return id.split("?")[0] ?? id;
}

/**
 * HTML 入口里的产品名占位符。
 * 用 `{{...}}` 而不是 Vite 的 `%VITE_*%`，避免和 HTML env 替换语法撞车。
 */
const ZCODE_PRODUCT_NAME_PLACEHOLDER = "{{ZCODE_PRODUCT_NAME}}";

function escapeHtmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * 把 HTML 入口里的 {{ZCODE_PRODUCT_NAME}} 换成构建期产品名。
 *
 * Electron 里 document.title 就是窗口标题，所以标题写死 "ZCode" 时，
 * 自建客户端的窗口标题、任务栏悬停和 Alt+Tab 都会显示 "ZCode"，和官方版分不清。
 * 用占位符而不是匹配字面量，是为了后续新增入口页也能自动跟随身份。
 */
function htmlProductNamePlugin(productName: string): Plugin {
  return {
    name: "zcode:html-product-name",
    transformIndexHtml: (html) =>
      html.replaceAll(ZCODE_PRODUCT_NAME_PLACEHOLDER, escapeHtmlText(productName)),
  };
}

export default defineConfig(({ mode }) => {
  // `.env*` 只提供链接常量；当前产品环境由启动脚本或 CI 注入 ZCODE_ENV。
  const env = { ...loadEnv(mode, "../..", ""), ...process.env };
  const repoRoot = resolve(__dirname, "../..");
  const zcodeEnv = resolveZCodeEnv(env.ZCODE_ENV);
  // 安装包身份与后端环境分轴；renderer 用它决定是否展示更新入口。
  const zcodeProductFlavor = resolveDesktopProductFlavor({
    ...process.env,
    ...env,
    ZCODE_ENV: zcodeEnv,
  });
  // 产品身份（应用名 / appId）允许下游覆盖，与 tsup 保持同一份解析结果。
  const zcodeProductIdentity = resolveDesktopProductIdentityForFlavor(zcodeProductFlavor, {
    ...process.env,
    ...env,
    ZCODE_ENV: zcodeEnv,
  });
  const e2eCoverageEnabled =
    env.ZCODE_E2E_COVERAGE === "1" || process.env.ZCODE_E2E_COVERAGE === "1";
  const e2eStoreBridgeEnabled =
    env.VITE_ZCODE_E2E_STORE_BRIDGE === "1" || process.env.VITE_ZCODE_E2E_STORE_BRIDGE === "1";
  const zcodeEndpointOrigin = resolveZCodeEndpointOrigin({
    env: zcodeEnv,
    envBaseOrigin: env.ZCODE_BASE_URL ?? env.ZCODE_ENDPOINT_ORIGIN,
  });
  const codingPlanWebviewOrigin =
    env.VITE_CODING_PLAN_WEBVIEW_ORIGIN ?? process.env.VITE_CODING_PLAN_WEBVIEW_ORIGIN ?? "";
  const plugins = [
    ...(e2eCoverageEnabled ? [createE2EUIRendererCoveragePlugin(repoRoot)] : []),
    htmlProductNamePlugin(zcodeProductIdentity.productName),
    pdfJsCMapsPlugin(),
    react(),
    tailwindcss(),
  ];

  return {
    root: "src/renderer",
    plugins,
    resolve: {
      alias: {
        // 修复 UI 组件库中的 @ 别名解析失败。
        // 问题原因：desktop 会直接打包 packages/ui 的源码，但当前 Vite 配置不知道 @ 应该指向 packages/ui/src，
        // 导致 spinner、alert 等组件里的内部导入在构建时全部失效。
        // 这里在消费端补齐别名，比逐个改组件导入更稳，也能和 web 端保持一致。
        "@": resolve(__dirname, "../ui/src"),
        ...desktopRendererDependencyAliases,
        // Recharts 通过 d3-shape 读取 d3-path 的 Path 导出；hoisted node_modules
        // 里可能残留 d3-shape/node_modules/d3-path@1.x，Vite 预构建会优先命中旧包并报 Missing export。
        // 这里把 d3-path 固定到根部 3.x 入口，确保桌面端依赖优化和运行时解析一致。
        "d3-path": resolve(__dirname, "../../node_modules/d3-path/src/index.js"),
      },
      dedupe: ["react", "react-dom", "lucide-react"],
    },
    server: { port: 5174, strictPort: true },
    define: {
      __ZCODE_ENDPOINT_ENV__: JSON.stringify(pickProductEndpointEnv(env)),
      __ZCODE_VERSION__: JSON.stringify(buildMetadata.appVersion),
      __ZCODE_COMMIT__: JSON.stringify(buildMetadata.buildCommitId),
      __ZCODE_BUILD_TIME__: JSON.stringify(buildMetadata.buildTime),
      __ZCODE_ENV__: JSON.stringify(zcodeEnv),
      __ZCODE_PRODUCT_FLAVOR__: JSON.stringify(zcodeProductFlavor),
      __ZCODE_PRODUCT_NAME__: JSON.stringify(zcodeProductIdentity.productName),
      __ZCODE_DATA_ROOT_SUFFIX__: JSON.stringify(zcodeProductIdentity.dataRootSuffix),
      __ZCODE_LOCAL_DEVELOPMENT_RUNTIME__: JSON.stringify(mode !== "production"),
      "import.meta.env.VITE_ZCODE_BASE_URL": JSON.stringify(zcodeEndpointOrigin),
      // 兼容旧 renderer 读取名；新代码统一读 VITE_ZCODE_BASE_URL。
      "import.meta.env.VITE_ZCODE_ENDPOINT_ORIGIN": JSON.stringify(zcodeEndpointOrigin),
      "import.meta.env.VITE_CODING_PLAN_WEBVIEW_ORIGIN": JSON.stringify(codingPlanWebviewOrigin),
      "import.meta.env.VITE_REWARDS_WEBVIEW_ORIGIN": JSON.stringify(
        env.VITE_REWARDS_WEBVIEW_ORIGIN ?? process.env.VITE_REWARDS_WEBVIEW_ORIGIN ?? "",
      ),
      // E2E store bridge 只能由 WDIO 专用变量打开，避免把 ZCODE_ENV=test 产品环境误当成测试运行态。
      "import.meta.env.VITE_ZCODE_E2E_STORE_BRIDGE": JSON.stringify(
        e2eStoreBridgeEnabled ? "1" : "",
      ),
    },
    // Electron 用 file:// 协议加载页面，资源路径必须是相对路径，否则会 ERR_FILE_NOT_FOUND
    base: "./",
    worker: {
      rollupOptions: {
        // @pierre/diffs 的 worker 入口依赖 import 后注册 message 监听。
        // 它的 package sideEffects 漏声明会让生产 worker 子构建被摇成 0B；
        // 只关闭 worker 构建的摇树，避免影响主包。
        treeshake: false,
      },
    },
    build: {
      outDir: "../../out/renderer",
      emptyOutDir: true,
      // 生产包若直接暴露 sourceMappingURL，攻击者可在客户端侧还原业务源码。
      // 生产使用 hidden sourcemap：本地/发布流程保留 .map，不在产物里暴露映射入口。
      sourcemap: mode === "production" ? "hidden" : true,
      rollupOptions: {
        // 多入口：主窗口 + 进程监控 + CUA 权限拖拽浮窗
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
          "resource-manager": resolve(__dirname, "src/renderer/resource-manager.html"),
          "cua-permission-panel": resolve(__dirname, "src/renderer/cua-permission-panel.html"),
        },
      },
    },
  };
});
