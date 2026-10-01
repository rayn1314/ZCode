import assert from "node:assert/strict";
import test from "node:test";
import { SERVICE_AUTHORITY_MODE_ENV, ZCODE_DATA_ROOT_ENV } from "@zcode/shared";
import {
  buildRemoteServerBaseEnvAssignments,
  deriveRemoteDataRootEnvAssignment,
} from "../src/remote/deployShared.js";

test("official (empty suffix) derives no data-root assignment", () => {
  assert.equal(deriveRemoteDataRootEnvAssignment(""), null);
  assert.equal(deriveRemoteDataRootEnvAssignment("   "), null);
});

test("self-built suffix derives the $HOME-form data-root assignment", () => {
  assert.equal(deriveRemoteDataRootEnvAssignment("-rayn"), `ZCODE_DATA_ROOT="$HOME/.zcode-rayn"`);
  assert.equal(deriveRemoteDataRootEnvAssignment(" -rayn "), `ZCODE_DATA_ROOT="$HOME/.zcode-rayn"`);
});

test("base env assignments keep the historical shape in the official build", () => {
  // 测试进程没有编译期后缀注入（ZCODE_DATA_ROOT_SUFFIX 为空串），即官方分支：
  // 固定 env 段必须只有 authority mode 与 runtime root 两项，数据根不注入。
  const assignments = buildRemoteServerBaseEnvAssignments();
  assert.deepEqual(assignments, [
    `${SERVICE_AUTHORITY_MODE_ENV}="desktop-attached-remote"`,
    `ZCODE_SERVER_RUNTIME_ROOT="$HOME/.zcode/server"`,
  ]);
  assert.equal(
    assignments.some((item) => item.startsWith(ZCODE_DATA_ROOT_ENV)),
    false,
  );
});
