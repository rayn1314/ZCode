import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const allowedNetworkBoundaryFiles = new Set([
  "packages/adapters/src/auth/localhost-callback.ts",
  "packages/adapters/src/http/index.ts",
  // 仅使用 node:http 的状态码/类型，不执行网络请求。
  "packages/adapters/src/http/public-egress-policy.ts",
  // 它就是 MCP 的正式出网边界：把请求交给 network/proxy-fetch.ts 的代理 fetch。
  "packages/adapters/src/mcp/network.ts",
  // 通过调用方注入的 fetch 执行正式 Adapter 网络边界。
  "packages/adapters/src/model/model-option-map-fetch.ts",
  "packages/adapters/src/model/provider-endpoint-routing-fetch.ts",
  // 只读 node:http 的 IncomingMessage 类型，把已到手的响应交给 http/index.ts 与 proxy-fetch.ts，不发请求。
  "packages/adapters/src/network/incoming-response.ts",
  "packages/adapters/src/network/proxy-fetch.ts",
  "packages/cli/src/provider-runtime-env.ts",
  // Hook 的 http 回调：本 fork 新增的出网点，在 core 内自带 SSRF 校验
  // （resolveHttpRequest：仅 http/https，请求前解析并拒绝回环/链路本地/私网）。
  "packages/core/src/hooks/configured-runner-callback.ts",
  // WebFetch 工具只读取 node:http 状态码，真实请求由注入的执行端口完成。
  "packages/core/src/tool/handlers/webfetch.ts",
]);

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTypeScriptFiles(path)));
      continue;
    }
    if (entry.isFile() && path.endsWith(".ts")) {
      files.push(path);
    }
  }

  return files;
}

describe("core I/O boundaries", () => {
  it("keeps file tools and context assembly free of direct host I/O", async () => {
    const files = [
      "packages/core/src/runtime.ts",
      "packages/core/src/context/sections/request-user-context.ts",
      "packages/core/src/tool/handlers/read.ts",
      "packages/core/src/tool/handlers/write.ts",
      "packages/core/src/tool/handlers/edit.ts",
      "packages/core/src/tool/handlers/skill.ts",
    ];

    for (const file of files) {
      const content = await readFile(join(repoRoot, file), "utf8");
      expect(content, file).not.toMatch(
        /from\s+["'](?:node:fs|node:fs\/promises|fs\/promises)["']/,
      );
      expect(content, file).not.toMatch(/process\.(?:cwd|env|platform)/);
    }
  });

  it("keeps in-process HTTP egress behind adapter network boundaries", async () => {
    const packageSourceRoots = [
      "packages/adapters/src",
      "packages/bootstrap/src",
      "packages/cli/src",
      "packages/contracts/src",
      "packages/core/src",
      "packages/tui/src",
    ];
    const files = (
      await Promise.all(
        packageSourceRoots.map((root) => collectTypeScriptFiles(join(repoRoot, root))),
      )
    ).flat();
    const violations: string[] = [];

    for (const file of files) {
      // 白名单按 POSIX 写法列出，而 Windows 上 `path.relative` 给的是反斜杠；
      // 不归一化会让白名单整体失配，把所有合法的网络边界文件都误报成违规。
      const relativePath = relative(repoRoot, file).split(sep).join("/");
      if (allowedNetworkBoundaryFiles.has(relativePath)) {
        continue;
      }

      const content = await readFile(file, "utf8");
      if (
        /\bfetch\s*\(/.test(content) ||
        /\bhttps?\.request\s*\(/.test(content) ||
        /from\s+["']node:https?["']/.test(content)
      ) {
        violations.push(relativePath);
      }
    }

    expect(violations).toEqual([]);
  });
});
