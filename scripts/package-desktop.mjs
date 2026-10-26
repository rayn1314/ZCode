#!/usr/bin/env node

// Fork 自建版一键打包入口：bootstrap → 远端资产 → WSL Server 部署 → Windows 打包。
//
// 为什么把顺序和身份环境收在仓库里：个人构建脚本手排步骤曾漏掉 agent bundle
// 暂存（prepare:remote-assets 会清空 bundled-agents/<platform>/glm），打出缺
// koffi 的包。现在步骤顺序、身份默认值都由这一处保证，克隆源码的人执行
// `pnpm package:desktop` 就得到完整正确的包；打包前 beforePack 还会再自查一次
// 暂存新鲜度，任何调用顺序都不会再缺资源。
//
// WSL 部署放在 Windows 打包之前：它只依赖 prepare:remote-assets 的产物，先装完
// 就算 electron-builder 因 exe 被占用失败，WSL 这边也已经是新构建。部署失败或
// 跳过（没有 WSL、有运行中任务、首次安装）只告警，不阻断安装包产出。

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { runCommand } from "./spawn-command.mjs";
import { applyForkBuildEnvDefaults } from "./fork-build-env.mjs";

applyForkBuildEnvDefaults();

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skipWsl = process.argv.includes("--skip-wsl");

const steps = [
  { label: "bootstrap：安装依赖 + 准备桌面运行资源 + 构建各包", args: ["bootstrap"] },
  // 自建版连 WSL / SSH 时读本机的远端资产（启动器注入 ZCODE_REMOTE_ASSET_LOCAL_DIR
  // 指向 mock-cdn）；不准备就回落官方 CDN，官方 bundle 不认 fork 新字段，首同步失败。
  {
    label: "prepare:remote-assets：准备远端资产（server / node / node-pty / agent）",
    args: ["prepare:remote-assets"],
  },
  {
    label: "deploy:wsl-server：把新构建装进本机 WSL（--skip-wsl 或 ZCODE_SKIP_WSL_DEPLOY=1 跳过）",
    args: ["deploy:wsl-server"],
    optional: true,
    skip: skipWsl,
  },
  {
    label: "package:win：electron-builder 打包 + exe 版本信息回填",
    args: ["--filter", "@zcode/desktop", "package:win"],
  },
];

for (const step of steps) {
  if (step.skip) {
    console.log(`\n[package:desktop] --skip 已跳过：${step.label}`);
    continue;
  }
  console.log(`\n[package:desktop] ==> ${step.label}`);
  try {
    runCommand("pnpm", step.args, { cwd: repoRoot, env: process.env });
  } catch (error) {
    if (!step.optional) throw error;
    console.error(`[package:desktop] 警告：${step.label} 失败，继续后续步骤`);
    console.error(`[package:desktop] ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log("\n[package:desktop] 全部完成。启动自建版：pnpm --filter @zcode/desktop launch");
