/**
 * 手机远控 PWA 资产 staging：把生产构建产物整理成随包目录。
 *
 * 桌面端允许用户在弹层里一键启动手机远控，托管的是本仓库的 packages/web。
 * 生产构建的 sourcemap 不进安装包（~84MB 的调试信息对运行毫无用处），
 * 同时剔除 vendor 自带的测试目录，只留运行期真正需要的文件。
 *
 * 产物目录：packages/desktop/bundled-mobile-remote/（由 electron-builder
 * 的 extraResources 拷到 <resources>/mobile-remote）。
 * 与 bundled-agents / bundled-tools 同一套 staging 约定：beforePack 准备，
 * extraResources 只负责拷。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const webDist = join(repoRoot, "packages", "web", "dist");
const stageDir = join(repoRoot, "packages", "desktop", "bundled-mobile-remote");

function fail(message) {
  console.error(`[mobile-remote-bundle] ${message}`);
  process.exit(1);
}

function stageOnly() {
  if (!existsSync(join(webDist, "index.html"))) {
    fail(
      `缺少 packages/web/dist/index.html。请先在仓库根目录执行 pnpm --filter @zcode/web run build`,
    );
  }
  mkdirSync(dirname(stageDir), { recursive: true });
  rmSync(stageDir, { force: true, recursive: true });
  cpSync(webDist, stageDir, {
    recursive: true,
    // sourcemap 与测试/manifest 不属于运行期资源。
    filter: (source) => {
      if (source.endsWith(".map")) return false;
      const base = source.split(/[\\/]/).pop();
      return base !== "test" && base !== "tests" && base !== "THIRD-PARTY-NOTICES.md";
    },
  });
  let total = 0;
  const count = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      total += entry.isDirectory() ? 0 : statSync(full).size;
      if (entry.isDirectory()) count(full);
    }
  };
  count(stageDir);
  console.log(`[mobile-remote-bundle] staged ${(total / 1024 / 1024).toFixed(1)} MB → ${stageDir}`);
}

stageOnly();
