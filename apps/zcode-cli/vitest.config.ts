import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 清掉宿主注入的应用级 env（ZCODE_DATA_ROOT 等），否则用例会绕过临时目录读写真实数据根。
    // 用绝对路径：从 packages/<pkg> 目录运行时，相对路径会相对 cwd 解析而找不到本文件。
    setupFiles: [resolve(__dirname, "vitest.setup.ts")],
    // Bugfix: 外部 zcode-cli 历史里同时存在 test/ 和 tests/ 目录；合入 apps 后需要同时保留两种约定，避免新增包测试被根 include 规则过滤掉。
    include: [
      "test/**/*.test.ts",
      "tests/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
      "packages/*/tests/**/*.test.ts",
    ],
  },
});
