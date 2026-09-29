import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  registerProcessLevelErrorCapture,
  type ProcessErrorCaptureTarget,
} from "../src/main/desktopProcessErrorCapture.js";

function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function createFixture() {
  const target: ProcessErrorCaptureTarget = new EventEmitter();
  const loggedErrors: unknown[][] = [];
  const exitCalls: number[] = [];
  registerProcessLevelErrorCapture(
    { error: (...args: unknown[]) => loggedErrors.push(args) },
    { target, exit: (code) => exitCalls.push(code) },
  );
  return { target, loggedErrors, exitCalls };
}

test("uncaughtException 同步落日志、让出事件循环后以致命码退出", async () => {
  const { target, loggedErrors, exitCalls } = createFixture();
  const boom = new Error("fatal boom");

  target.emit("uncaughtException", boom);

  assert.deepEqual(loggedErrors, [["[crash-capture] uncaughtException:", boom]]);
  assert.deepEqual(exitCalls, []);
  await nextTick();
  assert.deepEqual(exitCalls, [1]);
});

test("unhandledRejection 只记录不退出", async () => {
  const { target, loggedErrors, exitCalls } = createFixture();
  const reason = new Error("async boom");

  target.emit("unhandledRejection", reason, Promise.resolve());
  await nextTick();

  assert.deepEqual(loggedErrors, [["[crash-capture] unhandledRejection:", reason]]);
  assert.deepEqual(exitCalls, []);
});

test("同一目标重复注册是幂等空操作", async () => {
  const { target, exitCalls } = createFixture();
  const secondLoggedErrors: unknown[][] = [];
  const secondExitCalls: number[] = [];
  registerProcessLevelErrorCapture(
    { error: (...args: unknown[]) => secondLoggedErrors.push(args) },
    { target, exit: (code) => secondExitCalls.push(code) },
  );

  target.emit("uncaughtException", new Error("again"));
  await nextTick();

  assert.deepEqual(secondLoggedErrors, []);
  assert.deepEqual(secondExitCalls, []);
  assert.equal(exitCalls.length, 1);
});
