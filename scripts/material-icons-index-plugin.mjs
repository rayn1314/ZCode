import { readdirSync } from "node:fs";

/**
 * 把 material-icons 素材文件名清单注入为编译期常量（__MATERIAL_ICONS_INDEX__）。
 * 渲染层在拼出注定失败的请求前，用这份清单把"素材里不存在的图标名"回退到 document
 * （见 packages/ui/src/lib/fileDisplayHelpers.ts），根治控制台持续刷 ERR_FILE_NOT_FOUND。
 *
 * 放在两个消费端（desktop / web）的 vite config 中各挂一次：
 *   materialIconsIndexPlugin({ iconsDir: resolve(__dirname, "src/renderer/public/material-icons") })
 */
export const MATERIAL_ICONS_INDEX_GLOBAL = "__MATERIAL_ICONS_INDEX__";

// 回退链的底座，缺失则未知图标连兜底目标都没有。
const REQUIRED_BASE_ICONS = ["document", "folder"];

export function materialIconsIndexPlugin({ iconsDir }) {
  const names = readdirSync(iconsDir)
    .filter((fileName) => fileName.endsWith(".svg"))
    .map((fileName) => fileName.slice(0, -".svg".length));
  for (const required of REQUIRED_BASE_ICONS) {
    if (!names.includes(required)) {
      throw new Error(`material-icons 素材缺少回退资源 ${required}.svg（${iconsDir}）`);
    }
  }
  return {
    name: "material-icons-index",
    config: () => ({
      define: { [MATERIAL_ICONS_INDEX_GLOBAL]: JSON.stringify(names) },
    }),
  };
}
