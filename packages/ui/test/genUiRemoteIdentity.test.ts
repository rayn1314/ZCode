import { describe, expect, it } from "vitest";
import {
  resolveGenUiTargetRemoteIdentity,
  type GenUiRemoteIdentityTab,
} from "../src/gen-ui/domain/remoteIdentity.js";

const remoteTab: GenUiRemoteIdentityTab = {
  workspacePath: "//wsl.localhost/Ubuntu/home/rayn/project",
  workspaceIdentity: "wsl:Ubuntu:rayn",
  remoteSessionId: "sess_remote-1",
};

const localTab: GenUiRemoteIdentityTab = {
  workspacePath: "C:\\Users\\rayn\\project",
};

describe("resolveGenUiTargetRemoteIdentity", () => {
  it("目标已带身份时原样返回，不借用 tab", () => {
    expect(
      resolveGenUiTargetRemoteIdentity({
        workspacePath: remoteTab.workspacePath,
        workspaceIdentity: remoteTab.workspaceIdentity,
        remoteSessionId: remoteTab.remoteSessionId,
        workspaceTabs: [localTab],
      }),
    ).toEqual({
      workspaceIdentity: remoteTab.workspaceIdentity,
      remoteSessionId: remoteTab.remoteSessionId,
    });
  });

  it("目标只带 remoteSessionId 时保留该字段", () => {
    expect(
      resolveGenUiTargetRemoteIdentity({
        workspacePath: "//wsl.localhost/Ubuntu/home/rayn/project",
        remoteSessionId: "sess_remote-1",
        workspaceTabs: [localTab],
      }),
    ).toEqual({ remoteSessionId: "sess_remote-1" });
  });

  it("身份缺失时借用唯一匹配的远程 tab 身份", () => {
    expect(
      resolveGenUiTargetRemoteIdentity({
        workspacePath: remoteTab.workspacePath,
        workspaceTabs: [localTab, remoteTab],
      }),
    ).toEqual({
      workspaceIdentity: remoteTab.workspaceIdentity,
      remoteSessionId: remoteTab.remoteSessionId,
    });
  });

  it("侧聊与主会话共享同一 workspacePath（多 tab 同路径）仍能借到身份", () => {
    const sideChatTab: GenUiRemoteIdentityTab = {
      workspacePath: remoteTab.workspacePath,
      remoteSessionId: "sess_remote-1",
    };
    expect(
      resolveGenUiTargetRemoteIdentity({
        workspacePath: remoteTab.workspacePath,
        workspaceTabs: [sideChatTab, remoteTab],
      }),
    ).toEqual({ remoteSessionId: "sess_remote-1" });
  });

  it("只靠 remoteTarget 的 tab 也能兜底", () => {
    const remoteTargetTab: GenUiRemoteIdentityTab = {
      workspacePath: remoteTab.workspacePath,
      remoteTarget: { connectionKind: "remote" },
    };
    expect(
      resolveGenUiTargetRemoteIdentity({
        workspacePath: remoteTab.workspacePath,
        workspaceTabs: [remoteTargetTab],
      }),
    ).toEqual({ remoteTarget: { connectionKind: "remote" } });
  });

  it("匹配 tab 全是本地元数据时返回 null", () => {
    expect(
      resolveGenUiTargetRemoteIdentity({
        workspacePath: "C:\\Users\\rayn\\project",
        workspaceTabs: [localTab],
      }),
    ).toBeNull();
  });

  it("无 workspacePath 时不走兜底", () => {
    expect(
      resolveGenUiTargetRemoteIdentity({
        workspacePath: null,
        workspaceTabs: [remoteTab],
      }),
    ).toBeNull();
  });

  it("空白字符串身份视为缺失，走 tab 兜底", () => {
    expect(
      resolveGenUiTargetRemoteIdentity({
        workspacePath: remoteTab.workspacePath,
        workspaceIdentity: "   ",
        remoteSessionId: undefined,
        workspaceTabs: [remoteTab],
      }),
    ).toEqual({
      workspaceIdentity: remoteTab.workspaceIdentity,
      remoteSessionId: remoteTab.remoteSessionId,
    });
  });
});
