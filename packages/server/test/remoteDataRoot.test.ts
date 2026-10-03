import assert from "node:assert/strict";
import test from "node:test";
import {
  SERVICE_AUTHORITY_MODE_ENV,
  SESSION_MAILBOX_ROOT_ENV,
  ZCODE_DATA_ROOT_ENV,
} from "@zcode/shared";
import {
  buildRemoteServerBaseEnvAssignments,
  deriveRemoteDataRootEnvAssignment,
  deriveRemoteMailboxRootEnvAssignment,
} from "../src/remote/deployShared.js";

test("official (empty suffix) derives no data-root assignment", () => {
  assert.equal(deriveRemoteDataRootEnvAssignment(""), null);
  assert.equal(deriveRemoteDataRootEnvAssignment("   "), null);
});

test("self-built suffix derives the $HOME-form data-root assignment", () => {
  assert.equal(deriveRemoteDataRootEnvAssignment("-rayn"), `ZCODE_DATA_ROOT="$HOME/.zcode-rayn"`);
  assert.equal(deriveRemoteDataRootEnvAssignment(" -rayn "), `ZCODE_DATA_ROOT="$HOME/.zcode-rayn"`);
});

test("remote mailbox root follows the data-root suffix; official derives none", () => {
  // mailbox 是同机兜底通道，必须和远端数据根落在同一棵树，否则实时投递与 drain 各写一份。
  assert.equal(deriveRemoteMailboxRootEnvAssignment(""), null);
  assert.equal(deriveRemoteMailboxRootEnvAssignment("   "), null);
  assert.equal(
    deriveRemoteMailboxRootEnvAssignment("-rayn"),
    `ZCODE_MAILBOX_ROOT="$HOME/.zcode-rayn/mailbox"`,
  );
});

test("base env assignments keep the historical shape in the official build", () => {
  // 测试进程没有编译期后缀注入（ZCODE_DATA_ROOT_SUFFIX 为空串），即官方分支：
  // 固定 env 段必须只有 authority mode 与 runtime root 两项，数据根与 mailbox 都不注入。
  const assignments = buildRemoteServerBaseEnvAssignments();
  assert.deepEqual(assignments, [
    `${SERVICE_AUTHORITY_MODE_ENV}="desktop-attached-remote"`,
    `ZCODE_SERVER_RUNTIME_ROOT="$HOME/.zcode/server"`,
  ]);
  assert.equal(
    assignments.some((item) => item.startsWith(ZCODE_DATA_ROOT_ENV)),
    false,
  );
  assert.equal(
    assignments.some((item) => item.startsWith(SESSION_MAILBOX_ROOT_ENV)),
    false,
  );
});
