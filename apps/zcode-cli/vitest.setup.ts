// CLI 工作区的测试入口清理，与根 workspace 的 vitest.setup.ts 同源。
//
// 为什么需要：ZCode 会话本身就是宿主进程的子进程，`pnpm --dir apps/zcode-cli test` 会继承
// 宿主的应用级 env。其中 ZCODE_DATA_ROOT 会被 `resolveZCodeDataRoot()` 优先采用，直接压过
// 用例自己设置的 HOME / USERPROFILE——表现为「本地跑红、CI 跑绿」的假失败，且更危险的是
// 用例会绕过临时目录去读写真实用户数据根（2026-10-13 实测：saved-workflow-tools /
// saved-workflows-store 两个文件 9 个用例因此读到真实全局档）。数据根隔离规则见
// packages/services/spec/test-data-root-isolation.md。
//
// 只清「会改写路径解析或模式判定」的宿主注入变量；ZCODE_RG_BINARY / ZCODE_UGREP_BINARY 等是
// 宿主合法提供的测试依赖，不能一并删除。与根 workspace 的 vitest.setup.ts 保持同一清单。
for (const key of [
  "ZCODE_DATA_BASE_DIR",
  "ZCODE_DATA_ROOT",
  "ZCODE_DYNAMIC_WORKFLOW_MODE",
  "ZCODE_REMOTE_ASSET_LOCAL_DIR",
]) {
  delete process.env[key];
}
