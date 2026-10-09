import assert from "node:assert/strict";
import test from "node:test";
import type { ZCodeAppOptions } from "../src/app/types.js";
import { createConfigCliOverrides } from "../src/app/app-config-options.js";

/**
 * 工具面 ≠ 免审批清单（spec: `core/spec/subagent-permission-parity.md` D1）。
 *
 * `runtimeConfig.toolAllowlist` 是"会话级工具面（哪些工具注册/可见）"，
 * `permission.allowedTools` 是"免审批清单（哪些工具不用问）"。把前者投影成后者，等于宣布
 * 整个工具面都免审批——子会话冷恢复路径正是这样拿到"整面静默放行"的，于是同一个子代理
 * 第一轮会问、之后不问。
 *
 * 这里钉住三件事：子会话不投影、headless 的既有双语义不变、禁用清单照旧投影。
 */
function options(runtimeConfig: ZCodeAppOptions["runtimeConfig"]): ZCodeAppOptions {
  return { runtimeConfig } as ZCodeAppOptions;
}

const TOOL_FACE = ["Read", "Write", "Bash"];

test("子会话：工具面不投影成免审批清单", () => {
  const overrides = createConfigCliOverrides(
    options({ taskType: "subagent_child", toolAllowlist: TOOL_FACE }),
  );
  // 关键断言：整份白名单不得变成 permission.allowedTools（否则子会话写入一路静默放行）。
  assert.equal(overrides, undefined);
});

test("子会话：禁用清单照旧投影（硬禁用优先级不因去预授权而放松）", () => {
  const overrides = createConfigCliOverrides(
    options({
      taskType: "subagent_child",
      toolAllowlist: TOOL_FACE,
      toolDisallowlist: ["WebFetch"],
    }),
  );
  assert.deepEqual(overrides?.permission?.disallowedTools, ["WebFetch"]);
  assert.equal(overrides?.permission?.allowedTools, undefined);
});

test("子会话：模式仍然投影（授权判定落回与父会话同一套模式规则）", () => {
  const overrides = createConfigCliOverrides(
    options({ mode: "build", taskType: "subagent_child", toolAllowlist: TOOL_FACE }),
  );
  assert.equal(overrides?.permission?.mode, "build");
  assert.equal(overrides?.permission?.allowedTools, undefined);
});

test("非子会话：既有双语义保持不变（headless --allowed-tools 依旧免审批）", () => {
  const overrides = createConfigCliOverrides(options({ toolAllowlist: TOOL_FACE }));
  assert.deepEqual(overrides?.permission?.allowedTools, TOOL_FACE);
});

test("非子会话 + 禁用清单：两条都投影（回归保护）", () => {
  const overrides = createConfigCliOverrides(
    options({ toolAllowlist: TOOL_FACE, toolDisallowlist: ["Write"] }),
  );
  assert.deepEqual(overrides?.permission?.allowedTools, TOOL_FACE);
  assert.deepEqual(overrides?.permission?.disallowedTools, ["Write"]);
});
