import { readFile, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, relative, resolve, sep } from "node:path";

/**
 * relay 顺带托管的 PWA 静态资源（ZCODE_WEB_STATIC_ROOT 指向 packages/web/dist）。
 * 与 packages/server/src/http.ts 的静态策略保持一致：目录回退 index.html、
 * SPA fallback、路径穿越防护；这里不引入 Hono，保持 relay 入口轻量。
 */

const STATIC_MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function isInsideDirectory(root: string, candidate: string): boolean {
  const diff = relative(root, candidate);
  return diff === "" || (!diff.startsWith("..") && !diff.includes(`..${sep}`));
}

async function resolveStaticFile(
  root: string,
  pathname: string,
  spaFallback: boolean,
): Promise<string | null> {
  const normalizedPathname = pathname === "/" ? "/index.html" : pathname;
  let candidate: string;
  try {
    candidate = resolve(root, decodeURIComponent(normalizedPathname).replace(/^\/+/, ""));
  } catch {
    return null;
  }
  if (!isInsideDirectory(root, candidate)) {
    return null;
  }

  try {
    const candidateStat = await stat(candidate);
    if (candidateStat.isDirectory()) {
      candidate = resolve(candidate, "index.html");
      if (!isInsideDirectory(root, candidate)) {
        return null;
      }
      const indexStat = await stat(candidate);
      return indexStat.isFile() ? candidate : null;
    }
    if (candidateStat.isFile()) {
      return candidate;
    }
  } catch {
    // 静态资源未命中时进入 SPA fallback，保留真实文件错误的 404 语义。
  }

  if (!spaFallback) {
    return null;
  }
  const indexFile = resolve(root, "index.html");
  try {
    const indexStat = await stat(indexFile);
    return indexStat.isFile() ? indexFile : null;
  } catch {
    return null;
  }
}

/**
 * 返回静态资源响应器；命中返回 true（已写响应），未命中返回 false 交由调用方 404。
 */
export function createRelayStaticAssetResponder(options: {
  staticRoot: string;
  spaFallback?: boolean;
}): (response: ServerResponse, pathname: string, method: string) => Promise<boolean> {
  const root = resolve(options.staticRoot);
  const spaFallback = options.spaFallback ?? true;

  return async (response, pathname, method) => {
    const filePath = await resolveStaticFile(root, pathname, spaFallback);
    if (!filePath) {
      return false;
    }
    const body = await readFile(filePath);
    response.statusCode = 200;
    response.setHeader(
      "content-type",
      STATIC_MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream",
    );
    response.setHeader("content-length", String(body.byteLength));
    if (method === "HEAD") {
      response.end();
      return true;
    }
    response.end(body);
    return true;
  };
}
