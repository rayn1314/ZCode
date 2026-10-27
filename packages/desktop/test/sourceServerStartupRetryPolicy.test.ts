import { describe, expect, it } from "vitest";
import {
  planStartupRetry,
  STARTUP_RETRY_DELAYS_MS,
} from "../src/host/sourceServerStartupRetryPolicy.js";

describe("startup retry policy", () => {
  it("walks the bounded backoff table then exhausts", () => {
    expect(STARTUP_RETRY_DELAYS_MS).toEqual([15_000, 45_000, 105_000]);
    expect(planStartupRetry({ retriesSoFar: 0, stateAfterFailure: { state: "failed" } })).toEqual({
      kind: "retry",
      attempt: 1,
      delayMs: 15_000,
    });
    expect(planStartupRetry({ retriesSoFar: 1, stateAfterFailure: { state: "failed" } })).toEqual({
      kind: "retry",
      attempt: 2,
      delayMs: 45_000,
    });
    expect(planStartupRetry({ retriesSoFar: 2, stateAfterFailure: { state: "failed" } })).toEqual({
      kind: "retry",
      attempt: 3,
      delayMs: 105_000,
    });
    expect(planStartupRetry({ retriesSoFar: 3, stateAfterFailure: { state: "failed" } })).toEqual({
      kind: "exhausted",
    });
    expect(planStartupRetry({ retriesSoFar: 7, stateAfterFailure: { state: "failed" } })).toEqual({
      kind: "exhausted",
    });
  });

  it("treats ordinary failures as retryable regardless of an explicit retryable flag", () => {
    expect(
      planStartupRetry({
        retriesSoFar: 0,
        stateAfterFailure: { state: "failed", retryable: true },
      }),
    ).toMatchObject({ kind: "retry" });
    expect(
      planStartupRetry({ retriesSoFar: 0, stateAfterFailure: { state: "failed" } }),
    ).toMatchObject({ kind: "retry" });
  });

  it("skips user-action and terminal states", () => {
    for (const state of [
      "online",
      "offline",
      "absent",
      "updating",
      "retrying",
      "needs-install",
      "needs-upgrade",
      "identity-change-pending",
    ] as const) {
      expect(planStartupRetry({ retriesSoFar: 0, stateAfterFailure: { state } })).toEqual({
        kind: "skip",
      });
    }
    expect(
      planStartupRetry({
        retriesSoFar: 0,
        stateAfterFailure: { state: "failed", retryable: false },
      }),
    ).toEqual({ kind: "skip" });
  });

  it("enters the window while the aborted flight has not settled yet", () => {
    // 批次级超时先于 connectOnce 的 failed 落盘；调度判定可能读到 bootstrapping。
    expect(
      planStartupRetry({ retriesSoFar: 0, stateAfterFailure: { state: "bootstrapping" } }),
    ).toMatchObject({ kind: "retry", attempt: 1 });
  });

  it("prefers skip over exhaustion when a terminal state appears late in the window", () => {
    expect(
      planStartupRetry({
        retriesSoFar: 3,
        stateAfterFailure: { state: "needs-upgrade", retryable: false },
      }),
    ).toEqual({ kind: "skip" });
  });
});
