import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";

interface ProjectMemoryRootInput {
  cliStorageRoot: string;
  workspacePath: string;
}

/**
 * 记忆归属只认规范化后的工作目录，不参与 workspaceIdentity。
 *
 * identity 里带 Source Server 的 installationId，重装/重建 server root 会生成新 ID；
 * 把它写进记忆键等于让同一个项目在每次重装后换一个新空库。远程与本地因此共用
 * 同一套路径寻址，代价是两台不同主机上的同路径工作区会共享记忆——这是有意的取舍，
 * 需要区分时由调用方把主机语义放进路径。
 */
export function resolveProjectMemoryRoot(input: ProjectMemoryRootInput): string {
  const normalizedWorkspacePath = resolve(input.workspacePath);
  const keySource =
    process.platform === "win32"
      ? normalizedWorkspacePath.toLowerCase()
      : normalizedWorkspacePath;
  const hash = createHash("sha256").update(keySource).digest("hex").slice(0, 16);
  const slug = sanitizeProjectSlug(basename(normalizedWorkspacePath) || "project");

  return join(input.cliStorageRoot, "memories", "projects", `${slug}-${hash}`, "memory");
}

function sanitizeProjectSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug.length > 0 ? slug : "project";
}
