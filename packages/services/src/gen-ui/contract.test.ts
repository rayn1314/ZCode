import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GenUiStateTarget } from "@zcode/shared/gen-ui";
import { afterEach, describe, expect, it } from "vitest";

import { createGenUiStateStorage } from "./adapters/stateStorage.js";
import { IGenUiService } from "./contract.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

// 契约测试只依赖 contract 与模块内实现，断言的是 CONTRACT.md 里写下的不变量，不是适配器内部细节。
async function createStateStore() {
  const root = await mkdtemp(join(tmpdir(), "gen-ui-contract-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = createGenUiStateStorage(root);
  cleanup.push(() => store.dispose());
  return store;
}

describe("gen-ui-service contract", () => {
  it("身份由服务描述符承载：类型与运行时同一个名字，频道名固定为 gen-ui", () => {
    expect(IGenUiService.channelName).toBe("gen-ui");
  });

  it("组件状态按 workspace 身份与会话隔离，未写过的目标读到 null", async () => {
    const state = await createStateStore();
    const target: GenUiStateTarget = {
      workspacePath: "/workspace",
      sessionId: "task",
      path: "/workspace/chart.html",
    };
    await state.set(target, { modelContent: { year: 2026 }, privateContent: null });
    expect(await state.get(target)).toEqual({ modelContent: { year: 2026 }, privateContent: null });
    // 同一路径换会话或换 workspace 身份都读不到：状态不跨身份、不跨会话泄漏。
    expect(await state.get({ ...target, sessionId: "other" })).toBeNull();
    expect(await state.get({ ...target, workspaceIdentity: "remote-example" })).toBeNull();
  });

  it("set 是整份快照替换，不是字段合并", async () => {
    const state = await createStateStore();
    const target: GenUiStateTarget = {
      workspacePath: "/workspace",
      sessionId: "task",
      path: "/workspace/form.html",
    };
    await state.set(target, { modelContent: { step: 1, draft: "a" }, privateContent: null });
    await state.set(target, { modelContent: { step: 2 }, privateContent: null });
    expect(await state.get(target)).toEqual({ modelContent: { step: 2 }, privateContent: null });
  });

  it("list 只返回该 scope 的条目", async () => {
    const state = await createStateStore();
    const scope = { workspacePath: "/workspace", sessionId: "task" };
    expect(await state.list(scope)).toEqual([]);
    await state.set(
      { ...scope, path: "/workspace/a.html" },
      { modelContent: 1, privateContent: null },
    );
    expect((await state.list(scope)).map((entry) => entry.path)).toEqual(["/workspace/a.html"]);
    expect(await state.list({ ...scope, sessionId: "other" })).toEqual([]);
  });
});
