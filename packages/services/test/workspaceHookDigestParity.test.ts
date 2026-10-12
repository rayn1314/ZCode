import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHooksService } from "../src/hooks/hooksService.js";
import {
  buildWorkspaceHookBundleSnapshot,
  readWorkspaceHookProjectSources,
  resolveWorkspaceHookRuntimeRoot,
  workspaceHooksConfigSchema,
  type WorkspaceHooksConfig,
} from "@zcode/shared/workspace-hook-discovery";
import { sealDataRoot, type SealedDataRoot } from "./helpers/sealedDataRoot.js";

const roots: string[] = [];
const sealedHomes: SealedDataRoot[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "zcode-hook-digest-parity-"));
  roots.push(root);
  return root;
}

/**
 * 用户级 hooks 配置落在身份数据根 `{dataRoot}/cli/config.json`（hooksService `getRootDir("zcode")`），
 * 只 stub HOME 重定向不了它——必须用 `sealDataRoot` 把数据根钉在临时目录里。
 * 因本仓身份后缀为空串，`dataRoot === join(baseDir, ".zcode")`，夹具路径无需改动。
 * 规则见 `packages/services/spec/test-data-root-isolation.md`。
 */
async function makeHome(): Promise<string> {
  const sealed = await sealDataRoot("zcode-hook-digest-parity-home-");
  sealedHomes.push(sealed);
  return sealed.baseDir;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function parseJsonIfExists(path: string): Promise<unknown | undefined> {
  if (!existsSync(path)) return undefined;
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

afterEach(async () => {
  while (sealedHomes.length > 0) {
    await sealedHomes.pop()?.[Symbol.asyncDispose]();
  }
  await Promise.all(
    roots
      .splice(0)
      .map((root) =>
        import("node:fs/promises").then(({ rm }) => rm(root, { force: true, recursive: true })),
      ),
  );
  vi.unstubAllEnvs();
});

/**
 * D17/M1 digest parity 哨兵（Settings 侧自一致校验）：
 * 比较的是 Settings builder（hooksService.loadHooks）与其装配公式的 shared-API 镜像，
 * 锁定 hooksService 内部装配与 shared 公开 API 的一致性（防内部漂移）。
 * 注意：本测试**不覆盖 Runtime（config-factory）装配**——Runtime 入口的 parity 由
 * adapters 侧 tests/workspace-hook-digest-parity.test.ts 用真实 createConfig 产物对比，
 * 双 builder 分叉由那边负责转红；两处测试配套，改名/删除任一侧都必须同步另一侧。
 * 若 env/CLI 未来支持 hooks 或 OR-merge 语义变动导致双 builder 分叉，adapters 侧转红。
 */
describe("workspace hook dual builder digest parity (D17)", () => {
  it("hooksService snapshot 与 shared 装配规则镜像产出一致 digest", async () => {
    const home = await makeHome();
    const workspace = makeRoot();
    mkdirSync(join(workspace, ".git"), { recursive: true });
    writeJson(join(home, ".zcode", "cli", "config.json"), {
      hooks: { enabled: true, timeoutMs: 30_000 },
    });
    writeJson(join(workspace, "zcode.json"), {
      hooks: {
        enabled: true,
        events: {
          Stop: [
            {
              matcher: ".*",
              hooks: [{ type: "command", command: "echo parity-root", async: true }],
            },
          ],
        },
      },
    });
    writeJson(join(workspace, ".zcode", "config.json"), {
      hooks: {
        enabled: true,
        events: {
          SessionStart: [
            { hooks: [{ type: "process", command: "node", args: ["hook.mjs"], timeoutMs: 5_000 }] },
          ],
        },
      },
    });
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);

    // ── 参照侧：镜像 loadHooksImpl 的装配（project sources + user source → runtimeRoot）──
    const { sources: projectSources } = await readWorkspaceHookProjectSources({
      workingDirectory: workspace,
    });
    expect(projectSources.length).toBeGreaterThan(0);
    const userFile = (await parseJsonIfExists(join(home, ".zcode", "cli", "config.json"))) as
      | { hooks?: unknown }
      | undefined;
    const parsedUserHooks = workspaceHooksConfigSchema.safeParse(userFile?.hooks);
    const userHooks: WorkspaceHooksConfig | undefined = parsedUserHooks.success
      ? parsedUserHooks.data
      : undefined;
    const runtimeRoot = resolveWorkspaceHookRuntimeRoot([
      ...(userHooks ? [userHooks] : []),
      ...projectSources.map((source) => source.hooks),
    ]);
    const reference = buildWorkspaceHookBundleSnapshot({
      workspaceIdentity: workspace,
      workspacePath: workspace,
      sources: projectSources,
      runtimeRoot,
    });

    // ── 实测侧：Settings / hooksService ──
    const loaded = await createHooksService().loadHooks({ workspacePath: workspace });
    const actual = loaded.workspaceHookSnapshot;

    expect(actual).toBeDefined();
    expect(reference).toBeDefined();
    expect(actual?.bundleDigest).toBe(reference?.bundleDigest);
    expect(actual?.hooks.map((hook) => hook.hookDeclarationDigest)).toEqual(
      reference?.hooks.map((hook) => hook.hookDeclarationDigest),
    );
    expect(actual?.hooks.map((hook) => hook.resolvedTimeoutMs)).toEqual(
      reference?.hooks.map((hook) => hook.resolvedTimeoutMs),
    );
    expect(actual?.hooks.map((hook) => hook.configuredEnabled)).toEqual(
      reference?.hooks.map((hook) => hook.configuredEnabled),
    );
    // user hooks.enabled=true 必须传导为 runtimeHooksEnabled=true（否则两边都静默关闭）
    expect(reference?.hooks.every((hook) => hook.runtimeHooksEnabled)).toBe(true);
  });
});
