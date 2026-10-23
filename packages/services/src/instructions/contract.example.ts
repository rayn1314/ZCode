/**
 * instructions 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 *
 * 三段真实用法：
 * 1. host 侧构造服务（`packages/services/src/node.ts` 注册的唯一入口）。
 * 2. 设置页打开一张卡片：读现状，`targetPath` 与 `effectivePath` 可能不同。
 * 3. 首次新建 + 保存时基线过期：`conflict` 不是失败，交给用户裁决。
 */
import type { InstructionFileState, IInstructionsService } from "./contract.js";
import { createInstructionsService } from "./instructionsService.js";

/** host 侧唯一构造方式；远端 workspace / Web 不注册该服务。 */
export function instructionsServiceExample(): IInstructionsService {
  return createInstructionsService();
}

/** 读仓库级现状：命中上级目录时 `effectivePath` 与本目录落点不同，`ignoredCandidates` 列出被遮蔽的同级候选。 */
export async function readWorkspaceInstructionFile(
  service: IInstructionsService,
  workspacePath: string,
): Promise<InstructionFileState> {
  const state = await service.readInstructionFile({ workspacePath, scope: "workspace" });
  if (state.ignoredCandidates.length > 0) {
    // 同目录存在多份候选时，只有 effectivePath 那份会被 Agent 读到。
    return state;
  }
  return state;
}

/** 编辑并保存：以读到的 `mtimeMs` 作并发基线；别人改过就返回 conflict，磁盘原样保留。 */
export async function saveWorkspaceInstructionFile(
  service: IInstructionsService,
  workspacePath: string,
  content: string,
): Promise<{ ok: true } | { ok: false; reason: "conflict" | "not-writable" | "failed" }> {
  const before = await service.readInstructionFile({ workspacePath, scope: "workspace" });
  const result = await service.writeInstructionFile({
    workspacePath,
    scope: "workspace",
    content,
    // 落点不存在时基线为 null（按新建提交）；已存在时用读到的事实。
    expectedMtimeMs: before.mtimeMs,
  });
  return result.ok ? { ok: true } : { ok: false, reason: result.reason };
}
