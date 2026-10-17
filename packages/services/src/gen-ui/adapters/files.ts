import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import {
  GEN_UI_DOCUMENT_WRAPPER_PATTERN,
  GEN_UI_FRAGMENT_REQUIRED_MESSAGE,
  GEN_UI_HTML_MAX_BYTES,
  genUiStateTargetSchema,
  type GenUiDocument,
  type GenUiStateTarget,
} from "@zcode/shared/gen-ui";

export function assertGenUiFragment(html: string): void {
  if (Buffer.byteLength(html, "utf8") > GEN_UI_HTML_MAX_BYTES)
    throw new Error("Gen UI file exceeds 5 MB");
  if (GEN_UI_DOCUMENT_WRAPPER_PATTERN.test(html))
    throw new Error(`${GEN_UI_FRAGMENT_REQUIRED_MESSAGE}: ${describeFullDocument(html)}`);
}

/**
 * 形态违规的失败描述里带内容指纹：渲染失败报告的注入去重键含这条消息，因此模型把同一个
 * 文件改写后仍不合规时会再提醒一次；内容没变则维持去重（spec gen-ui-cross-host-render.md）。
 * 只放字节数与摘要，绝不放文件内容。
 */
function describeFullDocument(html: string): string {
  const bytes = Buffer.byteLength(html, "utf8");
  const digest = createHash("sha256").update(html, "utf8").digest("hex").slice(0, 16);
  return `it is a full HTML document (${bytes} bytes, content sha256:${digest})`;
}
export async function readGenUiDocument(
  raw: GenUiStateTarget,
  outputRoot: string,
): Promise<GenUiDocument> {
  const input = genUiStateTargetSchema.parse(raw);
  if (!isAbsolute(outputRoot) || !isAbsolute(input.path) || !isAbsolute(input.workspacePath))
    throw new Error("Invalid executor path");
  const root = resolve(outputRoot),
    file = normalize(input.path);
  const child = relative(root, file);
  // 根因：fork 会保留父会话的 HTML 路径，生成目录分组不能作为当前会话的读取限制。
  // 读取范围只由执行端 Host 的固定输出根目录决定，widget state 仍使用当前会话身份。
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child))
    throw new Error("Gen UI file is outside the host output directory");
  // 修复依据：realpath 后再做前缀判断仍可能放行替换中的符号链接；逐级拒绝链接并核对打开的文件身份。
  const canonicalRoot = await realpath(root);
  let current = canonicalRoot;
  for (const segment of child.split(sep)) {
    current = join(current, segment);
    if ((await lstat(current)).isSymbolicLink())
      throw new Error("Gen UI does not read symbolic links");
  }
  const before = await lstat(current);
  const canonicalFile = await realpath(current);
  const canonicalChild = relative(canonicalRoot, canonicalFile);
  if (
    !canonicalChild ||
    canonicalChild === ".." ||
    canonicalChild.startsWith(`..${sep}`) ||
    isAbsolute(canonicalChild)
  )
    throw new Error("Gen UI file escaped the output directory");
  if (!before.isFile() || before.size > GEN_UI_HTML_MAX_BYTES)
    throw new Error("Gen UI requires a regular file under 5 MB");
  const handle = await open(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
      throw new Error("Gen UI file changed while opening");
    const bytes = Buffer.alloc(GEN_UI_HTML_MAX_BYTES + 1);
    let used = 0;
    while (used < bytes.length) {
      const result = await handle.read(bytes, used, bytes.length - used, used);
      if (!result.bytesRead) break;
      used += result.bytesRead;
    }
    if (used > GEN_UI_HTML_MAX_BYTES) throw new Error("Gen UI file exceeds 5 MB");
    const html = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used));
    assertGenUiFragment(html);
    return { path: file, html };
  } finally {
    await handle.close();
  }
}
