import { describe, expect, it } from "vitest";

import {
  isDatabaseArchivePath,
  isExcludedRelativePath,
  registerProcessLevelErrorCapture,
  shouldApplyLogExportRetention,
  type ProcessErrorCaptureTarget,
} from "./contract.js";
import { desktopDiagnosticsModule } from "./module.js";

// 契约测试只 import contract 与 module，不知道实现是谁；同一份测试应同时跑真实现与跨进程代理。

/** 记录注册的监听与退出码；`on` 计数用来断言注册是幂等的。 */
function createCaptureTarget() {
  const listeners = new Map<string, (value: never) => void>();
  const registered: string[] = [];
  const target: ProcessErrorCaptureTarget = {
    on(eventName: "uncaughtException" | "unhandledRejection", listener: never) {
      registered.push(eventName);
      listeners.set(eventName, listener);
      return target;
    },
  };
  return { target, listeners, registered };
}

/** 让实现里的 `setImmediate(() => exit(code))` 跑完。 */
function nextImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("desktop-diagnostics contract", () => {
  it("declares its module manifest", () => {
    expect(desktopDiagnosticsModule.id).toBe("desktop-diagnostics");
  });

  it("崩溃捕获：未捕获异常先落日志再退出，未处理 rejection 只记录不退出，重复注册是空操作", async () => {
    const { target, listeners, registered } = createCaptureTarget();
    const logged: unknown[][] = [];
    const exits: number[] = [];
    const logger = { error: (...args: unknown[]) => logged.push(args) };

    registerProcessLevelErrorCapture(logger, { target, exit: (code) => exits.push(code) });
    // 同一 target 再注册一次：不新增监听（否则同一次崩溃记两遍、退两次）。
    registerProcessLevelErrorCapture(logger, { target, exit: (code) => exits.push(code) });
    expect(registered).toEqual(["uncaughtException", "unhandledRejection"]);

    listeners.get("uncaughtException")?.(new Error("boom") as never);
    expect(logged).toEqual([["[crash-capture] uncaughtException:", expect.any(Error)]]);
    // 日志同步落盘后让出一轮事件循环才退出：同进程其它监听者（ARMS jsError）得先跑完。
    expect(exits).toEqual([]);
    await nextImmediate();
    expect(exits).toEqual([1]);

    listeners.get("unhandledRejection")?.("nope" as never);
    expect(logged[1]).toEqual(["[crash-capture] unhandledRejection:", "nope"]);
    await nextImmediate();
    expect(exits).toEqual([1]);
  });

  it("导出包路径策略默认拒绝：crashpad dump 与顶层数据库不进包，前缀只按 / 边界匹配", () => {
    expect(isExcludedRelativePath(String.raw`crash\live\reports\5b2e2236.dmp`)).toBe(true);
    expect(isExcludedRelativePath("crash/archive/5b2e2236.dmp")).toBe(true);
    expect(isExcludedRelativePath("tasks-index.sqlite")).toBe(true);
    expect(isExcludedRelativePath("tasks-index.sqlite-wal")).toBe(true);
    expect(isDatabaseArchivePath("nested/dir/app.db-shm")).toBe(true);
    expect(isExcludedRelativePath("credentials.json")).toBe(true);

    // 路径段匹配必须卡 `/` 边界：repo-backup / sessions-old 不是 repo / sessions。
    expect(isExcludedRelativePath("repo/src/index.ts")).toBe(true);
    expect(isExcludedRelativePath("repo-backup/src/index.ts")).toBe(false);
    expect(isExcludedRelativePath("certs2/server.key")).toBe(false);
    expect(isExcludedRelativePath("sessions-old/2026/a.md")).toBe(false);
    // 普通日志与不是数据库的 .log 照常保留。
    expect(isExcludedRelativePath("logs/2026-10-23.log")).toBe(false);
    expect(isDatabaseArchivePath("logs/sqlite-errors.log")).toBe(false);
  });

  it("保留策略只作用于日志目录", () => {
    expect(shouldApplyLogExportRetention("logs/a.log")).toBe(true);
    expect(shouldApplyLogExportRetention(".zcode/cli/log/a.jsonl")).toBe(true);
    expect(shouldApplyLogExportRetention("settings/setting.json")).toBe(false);
  });
});
