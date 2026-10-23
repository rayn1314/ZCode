// 上游 v3.16.2 把 grouped 视图从 hooks/useGroupedTaskView + workspace-grouped-tasks
// 迁到 project-sidebar/grouped。这里保留仍在导出的纯转移函数断言；
// hook 门禁（shouldHideGroupedTaskContent / isGroupedTaskViewInitialized）随旧模块删除，
// 新模块没有同名能力，相关用例不再保留。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type { ZCodeGroupedTaskView } from "@zcode/services";
import { taskKey } from "@/project-sidebar/grouped/ids.js";
import {
  filterGroupedViewByTaskKeys,
  moveTaskByMenu,
  moveTaskOverTask,
} from "@/project-sidebar/grouped/view.js";

function createTaskMeta(overrides: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  return {
    taskId: "task-default",
    traceId: "trace-default",
    title: "默认任务",
    workspacePath: "/repo/default",
    createdAt: 1,
    updatedAt: 1,
    mode: "default",
    provider: "glm",
    ...overrides,
  };
}

function createGroupNode(
  id: string,
  tasks: ZCodeTaskMeta[],
): Extract<ZCodeGroupedTaskView["nodes"][number], { type: "group" }> {
  return {
    type: "group",
    group: {
      id,
      title: id,
      color: "gray",
      createdAt: 1,
      updatedAt: 1,
    },
    tasks,
  };
}

function describeGroupedView(view: ZCodeGroupedTaskView): Array<string | string[]> {
  return view.nodes.map((node) =>
    node.type === "task"
      ? node.task.taskId
      : [node.group.id, ...node.tasks.map((task) => task.taskId)],
  );
}

describe("filterGroupedViewByTaskKeys", () => {
  it("keeps archiving tasks hidden when a stale authoritative view restores them", () => {
    const rootTask = createTaskMeta({ taskId: "root-task" });
    const groupTask = createTaskMeta({ taskId: "group-task" });
    const staleView: ZCodeGroupedTaskView = {
      nodes: [{ type: "task", task: rootTask }, createGroupNode("group-a", [groupTask])],
    };

    const filteredView = filterGroupedViewByTaskKeys(
      staleView,
      new Set([taskKey(rootTask), taskKey(groupTask)]),
    );

    expect(describeGroupedView(filteredView)).toEqual([["group-a"]]);
    expect(filterGroupedViewByTaskKeys(staleView, new Set())).toBe(staleView);
  });

  it("keeps the authoritative view as the baseline for grouped structure writes", () => {
    const source = readFileSync(
      resolve(process.cwd(), "packages/ui/src/project-sidebar/TaskGroupedView.tsx"),
      "utf8",
    );

    expect(source).toContain("moveTaskByMenu(authoritativeView, task, groupId)");
    expect(source).toContain("moveTaskToTopByMenu(authoritativeView, task)");
  });

  it("preserves an archiving task when another task changes group", () => {
    const archivingTask = createTaskMeta({ taskId: "archiving-task" });
    const movingTask = createTaskMeta({ taskId: "moving-task" });
    const authoritativeView: ZCodeGroupedTaskView = {
      nodes: [
        createGroupNode("group-a", [archivingTask, movingTask]),
        createGroupNode("group-b", []),
      ],
    };

    const nextView = moveTaskByMenu(authoritativeView, movingTask, "group-b");

    expect(describeGroupedView(nextView)).toEqual([
      ["group-a", "archiving-task"],
      ["group-b", "moving-task"],
    ]);
  });
});

describe("moveTaskOverTask", () => {
  it("reorders root task over root task by direction", () => {
    const rootA = createTaskMeta({ taskId: "root-a" });
    const rootB = createTaskMeta({ taskId: "root-b" });
    const rootC = createTaskMeta({ taskId: "root-c" });
    const view: ZCodeGroupedTaskView = {
      nodes: [
        { type: "task", task: rootA },
        { type: "task", task: rootB },
        { type: "task", task: rootC },
      ],
    };

    const nextView = moveTaskOverTask(view, {
      activeTaskKey: taskKey(rootA),
      overTaskKey: taskKey(rootC),
      position: "after",
    });

    expect(describeGroupedView(nextView)).toEqual(["root-b", "root-c", "root-a"]);
  });

  it("moves root task into target group when over a group task", () => {
    const rootA = createTaskMeta({ taskId: "root-a" });
    const groupTaskA = createTaskMeta({ taskId: "group-a-task-a" });
    const groupTaskB = createTaskMeta({ taskId: "group-a-task-b" });
    const view: ZCodeGroupedTaskView = {
      nodes: [{ type: "task", task: rootA }, createGroupNode("group-a", [groupTaskA, groupTaskB])],
    };

    const nextView = moveTaskOverTask(view, {
      activeTaskKey: taskKey(rootA),
      overTaskKey: taskKey(groupTaskB),
      position: "before",
    });

    expect(describeGroupedView(nextView)).toEqual([
      ["group-a", "group-a-task-a", "root-a", "group-a-task-b"],
    ]);
  });

  it("moves a group task across groups when over another group task", () => {
    const groupATask = createTaskMeta({ taskId: "group-a-task" });
    const groupBTask = createTaskMeta({ taskId: "group-b-task" });
    const view: ZCodeGroupedTaskView = {
      nodes: [createGroupNode("group-a", [groupATask]), createGroupNode("group-b", [groupBTask])],
    };

    const nextView = moveTaskOverTask(view, {
      activeTaskKey: taskKey(groupATask),
      overTaskKey: taskKey(groupBTask),
      position: "after",
    });

    expect(describeGroupedView(nextView)).toEqual([
      ["group-a"],
      ["group-b", "group-b-task", "group-a-task"],
    ]);
  });

  it("moves a group task to root when over a root task", () => {
    const rootA = createTaskMeta({ taskId: "root-a" });
    const rootB = createTaskMeta({ taskId: "root-b" });
    const groupTask = createTaskMeta({ taskId: "group-task" });
    const view: ZCodeGroupedTaskView = {
      nodes: [
        { type: "task", task: rootA },
        createGroupNode("group-a", [groupTask]),
        { type: "task", task: rootB },
      ],
    };

    const nextView = moveTaskOverTask(view, {
      activeTaskKey: taskKey(groupTask),
      overTaskKey: taskKey(rootA),
      position: "before",
    });

    expect(describeGroupedView(nextView)).toEqual(["group-task", "root-a", ["group-a"], "root-b"]);
  });
});
