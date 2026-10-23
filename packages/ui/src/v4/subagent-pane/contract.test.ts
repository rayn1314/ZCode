import { describe, expect, it } from "vitest";

import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import {
  buildSubagentSubBlockRows,
  didRowIdentitySpaceFlip,
  isColdWindowRowSpace,
  resolveRowSpaceFlipScrollTop,
  resolveSessionPaneCapabilities,
  type RowSpaceBaseline,
} from "./contract.js";
import { subagentPaneUiModule } from "./module.js";

// 契约测试只 import contract 与 module，不知道实现是谁；同一份测试应同时跑真实现与跨进程代理。
type Running = Parameters<typeof buildSubagentSubBlockRows>[0]["running"][number];
type Ended = Parameters<typeof buildSubagentSubBlockRows>[0]["endedItems"][number];

function running(childSessionId: string, startedAt?: number): Running {
  return {
    childSessionId,
    subagentType: "general-purpose",
    title: childSessionId,
    status: "running",
    ...(startedAt === undefined ? {} : { startedAt }),
  };
}

function ended(childSessionId: string, startedAt?: number): Ended {
  return {
    childSessionId,
    subagentType: "general-purpose",
    title: childSessionId,
    status: "success",
    ...(startedAt === undefined ? {} : { startedAt }),
  };
}

/** 判定只依赖行号身份。 */
function rowsOf(rowIds: number[]): ConversationRow[] {
  return rowIds.map((rowId) => ({ rowId }) as ConversationRow);
}

describe("subagent-pane-ui contract", () => {
  it("declares its module manifest", () => {
    expect(subagentPaneUiModule.id).toBe("subagent-pane-ui");
  });

  it("子区块：运行中不受 limit 限制、投影优先去重、还有 N 个用投影总数", () => {
    const model = buildSubagentSubBlockRows({
      running: [running("r-1", 9), running("shared", 8)],
      // shared 同时出现在投影与 ended 分页里：只保留运行中那一行（否则重复行 + 重复 key）。
      endedItems: [ended("shared", 8), ended("e-1", 3), ended("e-2", 2), ended("e-3", 1)],
      endedTotal: 9,
      limit: 2,
    });

    expect(model.rows.map((row) => row.childSessionId)).toEqual(["r-1", "shared", "e-1", "e-2"]);
    // 已结束显示 2 条（e-1/e-2），hidden = 9 - 2；用条数当总数会算成 2。
    expect(model.hiddenEndedCount).toBe(7);
    expect(model.rows[0]?.statusMessageId).toBe("subagentDirectory.status.running");
  });

  it("形态能力位：subagentChild 保留输入面与 edit/retry，去掉 fork / goal / 权限模式", () => {
    const child = resolveSessionPaneCapabilities("subagentChild");
    expect(child).toMatchObject({
      readOnly: false,
      composer: true,
      dropTarget: true,
      editRetry: true,
      fork: false,
      assistantFeedback: false,
      goalCommands: false,
      goalPanel: false,
      permissionModeSelector: false,
      cancelBackgroundWork: true,
      workspaceFileRewind: "always",
      runJournalQuery: true,
    });

    // observe 的 goal 展示保留（只有控制入口被关掉），且文件撤销是显式例外而不是布尔。
    const observe = resolveSessionPaneCapabilities("observe");
    expect(observe.readOnly).toBe(true);
    expect(observe.goalPanel).toBe(true);
    expect(observe.goalCommands).toBe(false);
    expect(observe.workspaceFileRewind).toBe("withAllowFlagOnly");

    // readOnly 只是形态的一列，四个形态只有 observe 为真。
    expect(
      (["interactive", "observe", "selectionSideChat", "subagentChild"] as const).map(
        (shape) => resolveSessionPaneCapabilities(shape).readOnly,
      ),
    ).toEqual([false, true, false, false]);
    // selectionSideChat 与 subagentChild 的差别只在 edit/retry。
    expect(resolveSessionPaneCapabilities("selectionSideChat").editRetry).toBe(false);
  });

  it("行身份空间：负数首行是窗口态，翻转才重锚定，算不出就交回调用方", () => {
    const windowRows = rowsOf([-900_000, -800_000]);
    const authoritativeRows = rowsOf([41, 42, 43]);
    expect(isColdWindowRowSpace(windowRows)).toBe(true);
    expect(isColdWindowRowSpace([])).toBe(false);

    const baseline: RowSpaceBaseline = {
      coldWindow: isColdWindowRowSpace(windowRows),
      anchor: { key: "turn-42", offsetTop: 120 },
    };
    expect(didRowIdentitySpaceFlip(baseline, authoritativeRows)).toBe(true);
    expect(didRowIdentitySpaceFlip(baseline, rowsOf([-700_000]))).toBe(false);
    // 首帧 / 切会话（基线缺席）与空窗口都不重锚定。
    expect(didRowIdentitySpaceFlip(null, authoritativeRows)).toBe(false);
    expect(didRowIdentitySpaceFlip(baseline, [])).toBe(false);

    expect(resolveRowSpaceFlipScrollTop(baseline.anchor, { start: 6400 })).toBe(6280);
    expect(resolveRowSpaceFlipScrollTop({ key: "turn-42", offsetTop: 120 }, null)).toBeNull();
  });
});
