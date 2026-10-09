import assert from "node:assert/strict";
import test from "node:test";
import { createSubagentSeatGate } from "../src/subagent/seat-gate.js";

/**
 * 座位闸门的核心契约（spec: core/spec/subagent-seat-gate-and-registry-bounds.md）：
 * - 容量内立即通过，超出按 FIFO 等座、有人归还后先来先走；
 * - 等座中 abort 即出队并拒绝，**不占座**；
 * - lease.release 是终局闩锁：重复 release 不会多放座位；
 * - 容量迟绑定：每次 acquire 读当前配置，调小不召回在跑的。
 */

function within<T>(promise: Promise<T>, label: string, ms = 5_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待超时：${label}`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** 推进微任务若干轮，让已 resolve 的等待者被恢复。 */
function flushMicrotasks(times = 3): Promise<void> {
  let chain = Promise.resolve();
  for (let index = 0; index < times; index++) {
    chain = chain.then(() => undefined);
  }
  return chain;
}

test("容量内立即通过；超出按 FIFO 等座，归还后先来先走", async () => {
  const gate = createSubagentSeatGate(2);
  const first = await gate.acquire({ capacity: 2 });
  const second = await gate.acquire({ capacity: 2 });
  assert.deepEqual(gate.stats(), { capacity: 2, held: 2, waiting: 0 });

  const order: string[] = [];
  const third = gate.acquire({ capacity: 2 }).then((lease) => {
    order.push("third");
    return lease;
  });
  const fourth = gate.acquire({ capacity: 2 }).then((lease) => {
    order.push("fourth");
    return lease;
  });
  await flushMicrotasks();
  assert.deepEqual(gate.stats(), { capacity: 2, held: 2, waiting: 2 });
  assert.deepEqual(order, [], "满员时新派发必须排队，不得插队");

  // 归还一个座位：FIFO 队首（third）先起跑，fourth 继续等。
  first.release();
  const thirdLease = await within(third, "third 拿到座位");
  await flushMicrotasks();
  assert.deepEqual(order, ["third"]);
  assert.deepEqual(gate.stats(), { capacity: 2, held: 2, waiting: 1 });

  second.release();
  const fourthLease = await within(fourth, "fourth 拿到座位");
  assert.deepEqual(order, ["third", "fourth"]);

  thirdLease.release();
  fourthLease.release();
  assert.equal(gate.stats().held, 0);
});

test("等座中 abort：取消等待且不占座，后续放行计数不漂", async () => {
  const gate = createSubagentSeatGate(1);
  const occupied = await gate.acquire({ capacity: 1 });

  const controller = new AbortController();
  const waiting = gate.acquire({ capacity: 1, signal: controller.signal });
  await flushMicrotasks();
  assert.equal(gate.stats().waiting, 1);

  controller.abort(new Error("parent turn cancelled"));
  await assert.rejects(waiting, /parent turn cancelled/);
  // 取消的等待者从未占座：held 仍是 1，waiting 出队归零。
  assert.deepEqual(gate.stats(), { capacity: 1, held: 1, waiting: 0 });

  // 已 abort 的 signal 在排队前就拒绝，同样不占座。
  await assert.rejects(gate.acquire({ capacity: 1, signal: controller.signal }));
  assert.equal(gate.stats().held, 1);

  // 座位归还后可以正常放行新的派发：计数没有因取消而漂移。
  occupied.release();
  const next = await gate.acquire({ capacity: 1 });
  assert.equal(gate.stats().held, 1);
  next.release();
  assert.equal(gate.stats().held, 0);
});

test("重复 release 幂等：不会多放座位", async () => {
  const gate = createSubagentSeatGate(1);
  const lease = await gate.acquire({ capacity: 1 });

  lease.release();
  lease.release();
  lease.release();
  assert.equal(gate.stats().held, 0, "重复 release 不得把 held 减成负数");

  // held 为负会凭空放行超额并发：两次 acquire 后必须仍受容量约束。
  const a = await gate.acquire({ capacity: 1 });
  const queued = gate.acquire({ capacity: 1 });
  let settled = false;
  void queued.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await flushMicrotasks();
  assert.equal(settled, false, "第二次 acquire 必须排队，说明没有被多放出的座位放行");
  a.release();
  const b = await within(queued, "排队者拿到座位");
  assert.equal(gate.stats().held, 1);
  b.release();
  assert.equal(gate.stats().held, 0);
});

test("容量迟绑定：acquire 时读新容量，调小不召回在跑的", async () => {
  const gate = createSubagentSeatGate(2);
  const first = await gate.acquire({ capacity: 2 });
  const second = await gate.acquire({ capacity: 2 });

  // 调小到 1：在座的两个不被召回，只是不再放行新的。
  const third = gate.acquire({ capacity: 1 });
  await flushMicrotasks();
  assert.deepEqual(gate.stats(), { capacity: 1, held: 2, waiting: 1 });
  assert.equal(
    await Promise.race([third.then(() => "granted"), flushMicrotasks().then(() => "wait")]),
    "wait",
  );

  // 归还一个座位：held 2→1，仍不满足 held < capacity(1)，继续不放行。
  first.release();
  await flushMicrotasks();
  assert.deepEqual(
    gate.stats(),
    { capacity: 1, held: 1, waiting: 1 },
    "held 1 不 < capacity 1：仍不放行",
  );
  second.release();
  const thirdLease = await within(third, "容量内放行");
  thirdLease.release();

  // 调大：新 acquire 立即按新容量通过。
  const wide = await gate.acquire({ capacity: 5 });
  assert.equal(gate.stats().held, 1);
  wide.release();
});
