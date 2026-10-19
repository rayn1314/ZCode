import { resolve } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

/**
 * 自己起一个真实 OS 进程并等它的用例：shell 执行与进程树回收、Windows Job Object、
 * MCP server 生命周期、CLI TUI 启动、原生搜索与 pdf 的子进程。这类用例在并发压力下会互相
 * 误杀、启动超时，或在收尾时原生崩溃。
 *
 * 入组判据是「测试拥有一个真实进程」，逐个核过 import 与用例意图；**不是**「历史上红过」——
 * CLI 子工作区没有根 vitest.config.ts 那样沉淀下来的 bugfix 记录可抄，所以这里只收判据清楚的。
 * 以后某个用例在并发下出现跨用例误杀、原生崩溃或启动超时，就把它加进来，并把原因写在旁边。
 *
 * 注意：`packages/cli/tests/` 用的是 node:test 约定，vitest 不收集它们（加进来也只会得到 0 个
 * 用例），别往这张表里放。
 *
 * 本文件的 `maxWorkers` 只管住「一次 vitest 运行」；工作区级入口 `pnpm test` 会再乘一层并行包数，
 * 所以 package.json 里给 `turbo run test` 加了 `--concurrency=2`（单包 4 worker × 并行包数）。
 * 两条一起才是完整的上限。
 */
const processOwningTests = [
  // shell 与进程树：这几个会真的 spawn shell，并在收尾时回收整棵进程树。
  "packages/adapters/tests/bash-direct-execution.test.ts",
  "packages/adapters/tests/bash-process-stop.test.ts",
  "packages/adapters/tests/bash-shutdown.test.ts",
  "packages/adapters/tests/exec.test.ts",
  // Windows Job Object 与进程探测：直接操作宿主进程表。
  "packages/adapters/tests/windows-job-object.test.ts",
  "packages/adapters/tests/process-probe.test.ts",
  // MCP server 子进程生命周期与崩溃恢复。
  "packages/adapters/tests/mcp-process-lifecycle.test.ts",
  "packages/adapters/tests/migration-crash-recovery.test.ts",
  "packages/adapters/tests/mcp-oauth-cross-process.e2e.test.ts",
  // 真实本地进程与原生子进程：TTFT 探针、原生搜索索引、pdfjs（pdfjs legacy 在 Windows 有
  // 原生崩溃史，根配置同样为此隔离了 ui 的 pdfJsCMapSupport.test.ts）。
  "packages/bootstrap/tests/local-ttft-process.test.ts",
  "packages/bootstrap/tests/embedded-search-native.e2e.test.ts",
  "packages/bootstrap/tests/read-pdf.e2e.test.ts",
  "packages/bootstrap/tests/read-pdf-model-switch.e2e.test.ts",
  // 守卫命令与子进程打包产物：都要起真进程验证退出语义。
  "packages/core/tests/guarded-command.test.ts",
  "packages/node-repl-host/test/bundle-smoke.test.ts",
];

// 清掉宿主注入的应用级 env（ZCODE_DATA_ROOT 等），否则用例会绕过临时目录读写真实数据根。
// 用绝对路径：从 packages/<pkg> 目录运行时，相对路径会相对 cwd 解析而找不到本文件。
const setupFiles = [resolve(__dirname, "vitest.setup.ts")];

// Bugfix: 外部 zcode-cli 历史里同时存在 test/ 和 tests/ 目录；合入 apps 后需要同时保留两种约定，避免新增包测试被根 include 规则过滤掉。
const include = [
  "test/**/*.test.ts",
  "tests/**/*.test.ts",
  "packages/*/test/**/*.test.ts",
  "packages/*/tests/**/*.test.ts",
];

// 4 是本仓库的既有口径（根 vitest.config.ts 同值）。机器更强时用环境变量临时放宽，别改这里：
// 上限的意义是「保住开发机」，不是「榨满 CPU」。
const configuredWorkers = Number.parseInt(process.env.ZCODE_CLI_TEST_MAX_WORKERS ?? "", 10);
const maxWorkers =
  Number.isFinite(configuredWorkers) && configuredWorkers > 0 ? configuredWorkers : 4;

export default defineConfig({
  test: {
    setupFiles,
    // 并行度必须有上限。CLI 工作区有 881 个测试文件，单包（bootstrap）就 200+ 个，其中一批会起
    // 真实 ZCode app（真 SQLite + 原生模块）和真子进程；vitest 不设上限时按 CPU 核数开 fork，
    // 16 核开发机上就是十几个进程同时起，再乘各自派生的子进程，机器直接被撑爆。
    maxWorkers,
    // 高负载下 spawn 子进程与模块 import 都会变慢，默认 5s 容易被提前打穿成 flaky 超时；
    // 官方入口 `pnpm test` 走 turbo，会同时跑多个包，压力只会更大。
    hookTimeout: 30_000,
    testTimeout: 30_000,
    // 通过用例的 console 不回显：runtime/services 层在绿态下也要刷几千行日志，全量输出会膨胀到
    // 数 MB，顶爆门禁对单条命令的 stdout 上限。失败用例的日志与断言 diff 原样保留。
    silent: "passed-only",
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include,
          exclude: [...configDefaults.exclude, ...processOwningTests],
          // 显式写出默认池（vitest 4 默认即 forks）：这里依赖「每个测试文件一个进程」来隔离
          // 用例间的 cwd/umask/信号等进程级状态竞争。
          pool: "forks",
          maxWorkers,
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: "process-isolated",
          include: processOwningTests,
          pool: "forks",
          // 进程密集的尾巴串行跑，且排在 unit 之后：避免与并发段抢 spawn 队列。
          fileParallelism: false,
          maxWorkers: 1,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
