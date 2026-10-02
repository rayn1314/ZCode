import assert from "node:assert/strict";
import test from "node:test";
import type { LedgerRootRef } from "../src/usage-ledger/ledgerRoots.js";
import {
  gateWslAggregation,
  mergeStaleWslRefs,
  WSL_BACKOFF_MS,
  WSL_STALE_KEEP_MS,
} from "../src/usage-ledger/ledgerWslVisibility.js";

// 契约：WSL 源「暂时不可聚合」（dump 失败退避、发行版停止、探测瞬态失败）时必须
// 保留在 snapshot.sources 里灰显（ok=false + 原因），绝不允许从来源列表里凭空消失。
// 回归背景：此前失败零日志 + 退避直接把源从探测结果里滤掉，用户看到 WSL 统计无声
// 消失且无从排查。

function wslRef(overrides: Partial<LedgerRootRef> = {}): LedgerRootRef {
  return {
    rootPath: "/home/u/.zcode-rayn",
    dbPath: "/home/u/.zcode-rayn/cli/db/db.sqlite",
    providerConfigPath: "/home/u/.zcode-rayn/v2/provider_config.json",
    kind: "wsl",
    distro: "Ubuntu",
    variant: "self",
    identity: "rayn",
    isPrimary: false,
    key: "wsl:Ubuntu@rayn",
    label: "WSL · Ubuntu · 自建 rayn",
    ...overrides,
  };
}

test("gate：正常运行的 WSL 源参与聚合", () => {
  const now = 1_000_000;
  const gate = gateWslAggregation(wslRef(), undefined, now);
  assert.deepEqual(gate, { aggregate: true });
});

test("gate：dump 失败退避窗口内拒绝聚合，error 带原始原因；过期后放行", () => {
  const now = 1_000_000;
  const failure = { at: now - 1_000, error: "sqlite3.OperationalError: database is locked" };
  const gate = gateWslAggregation(wslRef(), failure, now);
  assert.equal(gate.aggregate, false);
  if (!gate.aggregate) {
    assert.match(gate.error, /database is locked/);
  }

  const gateExpired = gateWslAggregation(wslRef(), failure, now + WSL_BACKOFF_MS + 1);
  assert.deepEqual(gateExpired, { aggregate: true });
});

test("gate：发行版停止（stale）的源拒绝聚合，error 说明原因", () => {
  const now = 2_000_000;
  const ref = wslRef({ staleAt: now - 5_000 });
  const gate = gateWslAggregation(ref, undefined, now);
  assert.equal(gate.aggregate, false);
  if (!gate.aggregate) {
    assert.match(gate.error, /未在运行/);
  }
});

test("gate：stale 超过保留期后放行（ref 会被探测层移除，闸门不再拦）", () => {
  const now = 3_000_000;
  const ref = wslRef({ staleAt: now - WSL_STALE_KEEP_MS - 1 });
  const gate = gateWslAggregation(ref, undefined, now);
  assert.deepEqual(gate, { aggregate: true });
});

test("gate：退避优先于 stale（error 保留更有信息量的失败原因）", () => {
  const now = 4_000_000;
  const ref = wslRef({ staleAt: now - 1_000 });
  const failure = { at: now - 1_000, error: "boom" };
  const gate = gateWslAggregation(ref, failure, now);
  assert.equal(gate.aggregate, false);
  if (!gate.aggregate) {
    assert.match(gate.error, /boom/);
  }
});

test("gate：windows 源不受 WSL 闸门影响（即便误传 failure）", () => {
  const now = 5_000_000;
  const ref = wslRef({ kind: "windows", distro: null, staleAt: now - 1_000 });
  const gate = gateWslAggregation(ref, { at: now, error: "x" }, now);
  assert.deepEqual(gate, { aggregate: true });
});

test("mergeStaleWslRefs：fresh 优先，本次未确认的旧源打 staleAt 保留", () => {
  const now = 6_000_000;
  const fresh = [
    wslRef({
      rootPath: "/home/u/.zcode",
      dbPath: "/home/u/.zcode/cli/db/db.sqlite",
      providerConfigPath: "/home/u/.zcode/v2/provider_config.json",
      key: "wsl:Ubuntu",
      label: "WSL · Ubuntu",
      variant: "official",
      identity: "",
    }),
  ];
  const previous = [
    wslRef(), // 本次未确认（发行版停止/根消失）→ 保留并打 staleAt
    fresh[0], // 已在 fresh 里 → 不重复
  ];
  const merged = mergeStaleWslRefs(previous, fresh, now);
  assert.equal(merged.length, 2);
  const stale = merged.find((r) => r.key === "wsl:Ubuntu@rayn");
  assert.ok(stale);
  assert.equal(stale.staleAt, now);
});

test("mergeStaleWslRefs：旧源沿用已有 staleAt 继续计时，超期移除", () => {
  const now = 7_000_000;
  const longGone = wslRef({ staleAt: now - WSL_STALE_KEEP_MS - 1 });
  const recentGone = wslRef({ key: "wsl:Debian", distro: "Debian", staleAt: now - 60_000 });
  const merged = mergeStaleWslRefs([longGone, recentGone], [], now);
  assert.deepEqual(
    merged.map((r) => r.distro),
    ["Debian"],
  );
  assert.equal(merged[0].staleAt, now - 60_000, "已有 staleAt 不应被刷新");
});

test("mergeStaleWslRefs：空 previous / 空 fresh 都安全", () => {
  const now = 8_000_000;
  assert.deepEqual(mergeStaleWslRefs([], [], now), []);
  const fresh = [wslRef()];
  assert.equal(mergeStaleWslRefs([], fresh, now)[0].staleAt, undefined);
});
