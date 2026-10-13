#!/usr/bin/env node

// Fork 自建版一键打包入口：bootstrap → 远端资产 → Windows 打包。
//
// 为什么把顺序和身份环境收在仓库里：个人构建脚本手排步骤曾漏掉 agent bundle
// 暂存（prepare:remote-assets 会清空 bundled-agents/<platform>/glm），打出缺
// koffi 的包。现在步骤顺序、身份默认值都由这一处保证，克隆源码的人执行
// `pnpm package:desktop` 就得到完整正确的包；打包前 beforePack 还会再自查一次
// 暂存新鲜度，任何调用顺序都不会再缺资源。

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { runCommand } from "./spawn-command.mjs";
import { applyForkBuildEnvDefaults } from "./fork-build-env.mjs";

applyForkBuildEnvDefaults();

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const steps = [
  { label: "bootstrap：安装依赖 + 准备桌面运行资源 + 构建各包", args: ["bootstrap"] },
  // 自建版连 WSL / SSH 时读本机的远端资产（启动器注入 ZCODE_REMOTE_ASSET_LOCAL_DIR
  // 指向 mock-cdn）；不准备就回落官方 CDN，官方 bundle 不认 fork 新字段，首同步失败。
  {
    label: "prepare:remote-assets：准备远端资产（server / node / node-pty / agent）",
    args: ["prepare:remote-assets"],
  },
  {
    label: "package:win：electron-builder 打包 + exe 版本信息回填",
    args: ["--filter", "@zcode/desktop", "package:win"],
  },
];

for (const step of steps) {
  console.log(`\n[package:desktop] ==> ${step.label}`);
  runCommand("pnpm", step.args, { cwd: repoRoot, env: process.env });
}

console.log("\n[package:desktop] 全部完成。启动自建版：pnpm --filter @zcode/desktop launch");
