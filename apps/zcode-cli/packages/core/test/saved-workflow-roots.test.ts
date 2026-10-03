import assert from "node:assert/strict";
import test from "node:test";
import { join, resolve } from "node:path";
import { ZCODE_DATA_ROOT_ENV } from "@zcode/contracts";
import {
  savedWorkflowRoot,
  savedWorkflowRoots,
} from "../src/tool/handlers/saved-workflows/store.js";

/**
 * 已保存工作流的全局根（契约）：项目档跟 cwd 走，全局档跟**身份数据根**走。
 *
 * 关键不变式是「全局档不再写死家目录」——并排安装的两个产品身份各有独立数据根，
 * 若全局根固定 `{home}/.zcode/workflows`，一个身份保存的 workflow 会被另一个身份列出来并执行。
 */

const CWD = resolve("repo-root");
const DATA_ROOT = resolve("home", ".zcode-rayn");

test("全局档落在身份数据根的 workflows/，项目档落在 cwd 的 .zcode/workflows/", () => {
  const roots = savedWorkflowRoots(CWD, { dataRootDir: DATA_ROOT });
  assert.deepEqual(roots, [
    { scope: "project", dir: join(CWD, ".zcode", "workflows") },
    { scope: "global", dir: join(DATA_ROOT, "workflows") },
  ]);
});

test("缺省数据根取 resolveZCodeDataRoot()：ZCODE_DATA_ROOT 覆盖生效", () => {
  const previous = process.env[ZCODE_DATA_ROOT_ENV];
  process.env[ZCODE_DATA_ROOT_ENV] = DATA_ROOT;
  try {
    assert.equal(savedWorkflowRoot(CWD, "global").dir, join(DATA_ROOT, "workflows"));
  } finally {
    if (previous === undefined) delete process.env[ZCODE_DATA_ROOT_ENV];
    else process.env[ZCODE_DATA_ROOT_ENV] = previous;
  }
});
