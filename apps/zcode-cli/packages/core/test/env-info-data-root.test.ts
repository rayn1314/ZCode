import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildEnvInfoSection } from "../src/context/sections/env-info.js";
import type { EnvInfo } from "../src/context/types.js";

/**
 * Environment 段身份数据根声明契约（spec: core/spec/env-info-data-root.md）：
 * - 数据根非常规（后缀 / ZCODE_DATA_ROOT 覆盖）时注入 `User data root` 行与共享域说明；
 * - 数据根就是常规 `~/.zcode` 时不注入，官方构建提示词保持原文。
 */

const ENV_INFO: EnvInfo = {
  cwd: "E:\\proj",
  platform: "win32",
  shell: "bash",
  osVersion: "win32 10.0",
  nodeVersion: "v24",
};

function withDataRootEnv(value: string | undefined, run: () => void): void {
  const previous = process.env.ZCODE_DATA_ROOT;
  try {
    if (value === undefined) {
      delete process.env.ZCODE_DATA_ROOT;
    } else {
      process.env.ZCODE_DATA_ROOT = value;
    }
    run();
  } finally {
    if (previous === undefined) {
      delete process.env.ZCODE_DATA_ROOT;
    } else {
      process.env.ZCODE_DATA_ROOT = previous;
    }
  }
}

test("非常规数据根注入 User data root 行与共享域说明", () => {
  const customRoot = join(homedir(), ".zcode-rayn");
  withDataRootEnv(customRoot, () => {
    const content = buildEnvInfoSection(ENV_INFO).content;
    assert.match(content, /- User data root: .+\.zcode-rayn/u);
    assert.match(
      content,
      /user-level skills \/ commands \/ plugins \/ AGENTS\.md are intentionally shared and stay under .+\.zcode\)/u,
    );
  });
});

test("常规根 ~/.zcode 不注入声明行", () => {
  withDataRootEnv(join(homedir(), ".zcode"), () => {
    const content = buildEnvInfoSection(ENV_INFO).content;
    assert.doesNotMatch(content, /User data root/u);
  });
});

test("未覆盖时按进程身份解析；默认身份（空后缀）即常规根，不注入", () => {
  withDataRootEnv(undefined, () => {
    const content = buildEnvInfoSection(ENV_INFO).content;
    // 测试进程无构建期后缀注入，默认根就是 ~/.zcode。若未来测试环境注入了后缀，
    // 这里应改为显式传后缀根并断言注入——保持与 resolveZCodeDataRoot 同源。
    assert.doesNotMatch(content, /User data root/u);
  });
});

test("Windows 下路径大小写差异不误判为非常规根", {
  skip: process.platform !== "win32",
}, () => {
  const upperDriveRoot = `${homedir().toUpperCase()}\\.zcode`;
  withDataRootEnv(upperDriveRoot, () => {
    const content = buildEnvInfoSection(ENV_INFO).content;
    assert.doesNotMatch(content, /User data root/u);
  });
});
