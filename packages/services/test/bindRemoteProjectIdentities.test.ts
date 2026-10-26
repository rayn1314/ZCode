import { describe, expect, it, vi } from "vitest";
import type { IProjectService } from "../src/project/contract.js";
import type { ProjectTree } from "../src/project-storage/contract.js";
import { bindRemoteProjectIdentities } from "../src/project/index.js";

const HOST_ID = "remote:server:0dd064e1";
const ROOT = "/home/rayn/workspace/repos";
/** storage canonical 命名空间：直接出边界会违反 task-groups 的 host 一致性不变式。 */
const CANONICAL_IDENTITY = "remote:wsl:Ubuntu:rayn";

function makeTree(withDeleted: boolean): ProjectTree {
  return {
    projects: [{ id: "p1", hostId: HOST_ID, name: "repos", roots: [{ rootPath: ROOT }] }],
    tasks: [
      {
        taskId: "t-live",
        workspacePath: ROOT,
        workspaceIdentity: CANONICAL_IDENTITY,
        hostId: HOST_ID,
      },
    ],
    ...(withDeleted
      ? {
          deletedTasks: [
            {
              taskId: "t-deleted",
              workspacePath: ROOT,
              workspaceIdentity: CANONICAL_IDENTITY,
              hostId: HOST_ID,
            },
          ],
        }
      : {}),
  } as unknown as ProjectTree;
}

function harness(tree: ProjectTree) {
  const resolveIdentity = vi.fn(
    async (workspacePath: string) => `remote:server:0dd064e1${workspacePath}`,
  );
  const wrapped = bindRemoteProjectIdentities(
    {
      readTree: async () => tree,
    } as unknown as IProjectService,
    resolveIdentity,
  );
  return { wrapped, resolveIdentity };
}

describe("bindRemoteProjectIdentities", () => {
  it("deletedTasks 与活任务走同一张身份映射重写为稳定身份", async () => {
    const { wrapped, resolveIdentity } = harness(makeTree(true));
    const tree = await wrapped.readTree({ includeDeletedTasks: true });
    const stable = `remote:server:0dd064e1${ROOT}`;
    expect(tree.tasks[0]?.workspaceIdentity).toBe(stable);
    expect(tree.deletedTasks?.[0]?.workspaceIdentity).toBe(stable);
    // 已删除任务的路径也必须进入解析集合，否则映射取不到值。
    expect(resolveIdentity).toHaveBeenCalledWith(ROOT);
  });

  it("树里没有 deletedTasks 时不产出该键", async () => {
    const { wrapped } = harness(makeTree(false));
    const tree = await wrapped.readTree({ includeDeletedTasks: false });
    expect(tree.deletedTasks).toBeUndefined();
  });
});
