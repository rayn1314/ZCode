import { afterEach, describe, expect, it, vi } from "vitest";
import type { IZCodeAgentService } from "@zcode/services";
import type { ZCodeAutomation } from "@zcode/shared";
import { useAutomationManagementStore } from "@/store/automationManagementStore.js";

const FUTURE_DEADLINE_MS = 1_893_456_000_000;

function makeAutomation(): ZCodeAutomation {
  return {
    automationId: "automation-1",
    title: "task",
    cronExpr: "0 9 * * *",
    prompt: "run",
    workspaceKey: "/tmp/ws",
    workspacePath: "/tmp/ws",
    locationKind: "local",
    recurring: true,
    runCount: 0,
    enabled: true,
    lifecycleStatus: "active",
    dispatchStatus: "idle",
    dispatchAttempts: 0,
    createdAt: 0,
    updatedAt: 0,
  };
}

function makeAgentService() {
  return {
    createAutomation: vi.fn(async () => ({ automationId: "automation-2" })),
    updateAutomation: vi.fn(async () => ({})),
  } as unknown as IZCodeAgentService;
}

describe("automationManagementStore goal fields passthrough", () => {
  afterEach(() => {
    useAutomationManagementStore.setState(useAutomationManagementStore.getInitialState(), true);
  });

  it("createAutomation 把 objective/deadlineMs/targetTaskId 原样透传给 RPC", async () => {
    const agentService = makeAgentService();
    useAutomationManagementStore.setState({
      workspacePath: "/tmp/ws",
      workspaceIdentity: null,
      automations: [],
    });

    await useAutomationManagementStore.getState().createAutomation(
      {
        title: "goal task",
        cronExpr: "",
        prompt: "run",
        objective: "持续改进代码质量",
        deadlineMs: FUTURE_DEADLINE_MS,
        targetTaskId: "session-1",
      },
      agentService,
    );

    expect(agentService.createAutomation).toHaveBeenCalledWith({
      workspacePath: "/tmp/ws",
      title: "goal task",
      cronExpr: "",
      prompt: "run",
      objective: "持续改进代码质量",
      deadlineMs: FUTURE_DEADLINE_MS,
      targetTaskId: "session-1",
    });
  });

  it("updateAutomation 把目标字段（含显式 null 清除语义）原样透传", async () => {
    const agentService = makeAgentService();
    useAutomationManagementStore.setState({
      workspacePath: "/tmp/ws",
      workspaceIdentity: null,
      automations: [makeAutomation()],
    });

    await useAutomationManagementStore.getState().updateAutomation(
      "automation-1",
      {
        objective: null,
        deadlineMs: FUTURE_DEADLINE_MS,
        targetTaskId: null,
      },
      agentService,
    );

    expect(agentService.updateAutomation).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: "/tmp/ws",
        automationId: "automation-1",
        objective: null,
        deadlineMs: FUTURE_DEADLINE_MS,
        targetTaskId: null,
      }),
    );
  });
});
