import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Logger } from "@zcode/contracts";
import { StartupTimer } from "../../src/startup-logging.js";
import { resolveStartupInputs } from "../../src/cli-startup-inputs/contract.js";

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

describe("cli-startup-inputs contract", () => {
  it("按当前磁盘现状解析：派生路径来自 storageRoot，且两次调用各自读盘（无缓存）", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-startup-inputs-"));
    try {
      const storage = join(root, "storage");
      const input = {
        options: {
          env: { ZCODE_STORAGE_DIR: storage },
          skipUserConfig: true,
          runtimeConfig: { workingDirectory: root },
        },
        workingDirectory: root,
        logger: silentLogger,
        startupTimer: new StartupTimer(silentLogger, {}),
      } as const;

      const first = await resolveStartupInputs(input);
      const second = await resolveStartupInputs(input);

      expect(first.storageRoot).toBe(storage);
      expect(first.cliStorageRoot).toBe(join(storage, "cli"));
      expect(first.modelIoDir).toBe(join(storage, "cli", "rollout"));
      // 空清单是合法结果：临时目录里没有用户/项目 profile，也没有内置技能包以外的东西。
      expect(Array.isArray(first.subagentProfiles)).toBe(true);
      expect(first.subagentBuiltInModelSelectionOverrides).toBeTypeOf("object");
      // 无缓存：复用只能由调用方显式传 startupInputs 表达，相同参数不会拿到同一个对象。
      expect(second).not.toBe(first);
      expect(second.pluginOutcome.plugins).not.toBe(first.pluginOutcome.plugins);
      expect(second.cliStorageRoot).toBe(first.cliStorageRoot);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
