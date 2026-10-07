// 子会话收件箱端口的构造契约（spec `subagent-session-as-first-class.md` 的 S3）。
//
// 为什么值得单独钉：这段曾经写成 `childScope ? undefined : (injected ?? fallback)`，把父注入
// 进来的那份端口一起丢了，于是「S3 给子会话开收件箱」的改动对派发路径完全无效，而冷恢复路径
// （没有覆盖包）反而一直有收件箱——两条构造路径的能力面刚好颠倒，且没有任何测试发现。
import assert from "node:assert/strict";
import test from "node:test";
import { resolveSessionMailboxPort } from "../src/app/subagent-child-scope.js";

const INJECTED = { id: "injected" };
const FROM_ENV = { id: "from-env" };

test("注入的端口优先，子/非子都一样（进程里只允许一份 mailbox 实例）", () => {
  assert.equal(
    resolveSessionMailboxPort({
      injected: INJECTED,
      isSubagentChildScope: true,
      fallback: () => FROM_ENV,
    }),
    INJECTED,
  );
  assert.equal(
    resolveSessionMailboxPort({
      injected: INJECTED,
      isSubagentChildScope: false,
      fallback: () => FROM_ENV,
    }),
    INJECTED,
  );
});

test("子会话没有注入时**不**自己造端口（回落到 env 会多出第二份未读目录视图）", () => {
  let fallbackCalls = 0;
  assert.equal(
    resolveSessionMailboxPort({
      injected: undefined,
      isSubagentChildScope: true,
      fallback: () => {
        fallbackCalls += 1;
        return FROM_ENV;
      },
    }),
    undefined,
  );
  assert.equal(fallbackCalls, 0);
});

test("普通会话缺注入时按 env 兜底（既有行为不变）", () => {
  assert.equal(
    resolveSessionMailboxPort({
      injected: undefined,
      isSubagentChildScope: false,
      fallback: () => FROM_ENV,
    }),
    FROM_ENV,
  );
});
