import { afterEach, vi } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";

process.env.GIT_CONFIG_COUNT = "2";

// Bugfix: Git Bash 会把 /usr/bin（GNU tar 1.35）注入 PATH 最前，子进程 spawn "tar"
// 解析到 GNU tar 后会把归档参数里的 `C:` 当远程主机（"Cannot connect to C"），
// zcode-server-cli 打包/发布与 native-search 归档类测试因此在 Windows 开发机整批失败。
// 真实 Windows 用户 PATH 中 System32 本就靠前、产品环境一直用 bsdtar；这里恢复同样顺序。
if (process.platform === "win32") {
  const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  if (existsSync(join(system32, "tar.exe"))) {
    const entries = (process.env.PATH ?? "").split(";");
    const rest = entries.filter((entry) => entry.toLowerCase() !== system32.toLowerCase());
    process.env.PATH = [system32, ...rest].join(";");
  }
}
process.env.GIT_CONFIG_KEY_0 = "core.autocrlf";
process.env.GIT_CONFIG_VALUE_0 = "false";
process.env.GIT_CONFIG_KEY_1 = "core.eol";
process.env.GIT_CONFIG_VALUE_1 = "lf";
process.env.ZCODE_TEST_RELEASE_TARGET = process.env.ZCODE_TEST_RELEASE_TARGET ?? "darwin";
process.env.ZCODE_TEST_RELEASE_ARCH = process.env.ZCODE_TEST_RELEASE_ARCH ?? "aarch64";
process.env.ZCODE_TEST_CLIENT_CONFIG_PLATFORM =
  process.env.ZCODE_TEST_CLIENT_CONFIG_PLATFORM ?? "darwin-aarch64";
// Bugfix: 桌面端会把自定义 dataBaseDir 通过环境变量注入到 host/git 子进程。
// 很多服务层单测只通过覆盖 HOME 来隔离临时目录；若保留该变量，路径解析会继续优先命中真实 dataBaseDir，
// 从而导致“终端本地跑通过，但应用内 git push 触发 pre-push 时大量用例误写到同一目录”。
// 这里在测试入口统一清理，保证单测默认只受各自显式设置的 HOME / setDataBaseDir 控制。
delete process.env.ZCODE_DATA_BASE_DIR;

// 身份数据根同理，且更隐蔽：envDataRootDir 是 paths 模块**加载期**捕获的常量，
// 覆盖不掉。测试环境若带着本机真实根（如 ~/.zcode-rayn），用例会绕过自己的临时目录
// 直接读写真实数据根——实测 43 个文件 / 404 个用例因此报 SQLite
// "database disk image is malformed"。本文件只 import 内置模块与 vitest，
// 保证这行先于任何被测模块求值；需要显式根的用例改用 setDataRootDir 封根。
delete process.env.ZCODE_DATA_ROOT;

// 宿主（ZCode 会话/桌面应用）还会注入会改写「运行模式判定 / 本地资源路径」的应用级变量，
// 在会话内直接跑 `pnpm test:unit` 会继承它们、与干净 CI 分叉：实测
// dynamicWorkflowClientConfig（mode 被抬成 alwaysOn）与 desktopRuntimeEnv（资源解析到真实
// mock-cdn）两文件共 9 个用例因此假失败。用例若需要特定取值都在用例内显式设置，入口统一清掉安全。
const HOST_INJECTED_MODE_ENV_KEYS = ["ZCODE_DYNAMIC_WORKFLOW_MODE", "ZCODE_REMOTE_ASSET_LOCAL_DIR"];
for (const key of HOST_INJECTED_MODE_ENV_KEYS) {
  delete process.env[key];
}

afterEach(() => {
  delete process.env.ZCODE_DATA_BASE_DIR;
  delete process.env.ZCODE_DATA_ROOT;
  for (const key of HOST_INJECTED_MODE_ENV_KEYS) {
    delete process.env[key];
  }
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();

  return {
    ...actual,
    homedir: () => {
      const envHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
      return envHome && envHome.length > 0 ? envHome : actual.homedir();
    },
  };
});
