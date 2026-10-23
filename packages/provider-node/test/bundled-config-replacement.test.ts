import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { materializeZCodeBuiltinProviderConfig } from "../src/index.js";
import * as persistence from "@zcode/shared/node";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function environmentRoot() {
  const root = await mkdtemp(join(tmpdir(), "todo104-bundled-"));
  roots.push(root);
  return root;
}
function release(revision: number) {
  return JSON.stringify({
    schemaVersion: 1,
    revision,
    config: {
      providerConfigRules: { providerRules: [], templateRules: [] },
      modelConfigRules: {
        modelRules: [],
        modelApiRules: [],
        providerSiteRules: [],
        templateModelRules: [],
        builtinProviderModelRules: [],
      },
    },
  });
}

it("同内容并发启动复用固定资源且不改写文件", async () => {
  const environmentConfigRoot = await environmentRoot();
  const options = { environmentConfigRoot, content: release(1) };
  const file = await materializeZCodeBuiltinProviderConfig(options);
  const before = await stat(file, { bigint: true });
  expect(
    await Promise.all(
      Array.from({ length: 8 }, () => materializeZCodeBuiltinProviderConfig(options)),
    ),
  ).toEqual(Array(8).fill(file));
  expect((await stat(file, { bigint: true })).mtimeNs).toBe(before.mtimeNs);
  expect(await readdir(dirname(file))).toEqual(["zcode-builtin.json"]);
});

it("替换期间并发读取只见完整旧版或新版，不产生 hash 历史文件", async () => {
  const environmentConfigRoot = await environmentRoot();
  const file = await materializeZCodeBuiltinProviderConfig({
    environmentConfigRoot,
    content: release(1),
  });
  let finished = false;
  const writer = (async () => {
    try {
      for (let index = 0; index < 30; index++) {
        await materializeZCodeBuiltinProviderConfig({
          environmentConfigRoot,
          content: release((index % 2) + 1),
        });
      }
    } finally {
      finished = true;
    }
  })();
  const reader = (async () => {
    do {
      const fileContent = JSON.parse(await readFile(file, "utf8"));
      expect([1, 2]).toContain(fileContent.revision);
      expect(fileContent).toEqual(JSON.parse(release(fileContent.revision)));
      // Windows 上 rename 无法覆盖任何仍被打开的句柄（reader 自身也不行），空转轮询会让
      // 写侧永远抢不到窗口、3s 重试预算耗尽而 EPERM。让出一拍仍保持“读-写交错”的对抗性：
      // 每次写入期间都会发生多次完整读取，撕裂内容依旧会被这里抓到。
      if (process.platform === "win32") await sleep(1);
    } while (!finished);
  })();
  await Promise.all([writer, reader]);
  expect(await readdir(dirname(file))).toEqual(["zcode-builtin.json"]);
});

it("资源校验或原子写入失败时保留旧内容，错误向调用方报告", async () => {
  const environmentConfigRoot = await environmentRoot();
  const file = await materializeZCodeBuiltinProviderConfig({
    environmentConfigRoot,
    content: release(1),
  });
  const before = await readFile(file, "utf8");
  await expect(
    materializeZCodeBuiltinProviderConfig({ environmentConfigRoot, content: "{}" }),
  ).rejects.toThrow();
  vi.spyOn(persistence, "atomicWritePrivateTextFile").mockRejectedValueOnce(
    new Error("fixture write failure"),
  );
  await expect(
    materializeZCodeBuiltinProviderConfig({ environmentConfigRoot, content: release(2) }),
  ).rejects.toThrow("fixture write failure");
  expect(await readFile(file, "utf8")).toBe(before);
  expect(await readdir(dirname(file))).toEqual(["zcode-builtin.json"]);
});
