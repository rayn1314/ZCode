import { describe, expect, it, vi } from "vitest";
import type { RemoteTarget } from "@zcode/shared";
import { pushSubagentConfigToRemoteHosts } from "../src/host/remoteSubagentConfig.js";

// spec apps/zcode-cli/packages/core/spec/subagent-settings-sync.md D1：desktop-attached remote Host
// （SSH/WSL/Docker）读自己的数据根，副本只能由 Host 推；standalone server 有自己的权威，不推。

const authority = {
  state: {
    builtInModelSelectionOverrides: {
      "general-purpose": { providerId: "prov-1", modelId: "u2-flash" },
    },
    pluginAgentModelSelectionOverrides: {},
    disabledAgentIds: ["helper"],
  },
  files: { files: [{ name: "coder.md", content: "# coder\n" }] },
};

function connection(target: RemoteTarget) {
  return {
    target,
    subagentsService: {
      replaceSubagentState: vi.fn(async () => authority.state),
      replaceUserAgentFiles: vi.fn(async () => authority.files),
    },
    zcodeAgentService: { reloadSubagents: vi.fn(async () => undefined) },
  };
}

const ssh: RemoteTarget = { kind: "ssh", host: "h", username: "u" };
const server: RemoteTarget = { kind: "server", url: "https://s.example.com" };

describe("pushSubagentConfigToRemoteHosts（D1）", () => {
  it("推给 SSH/WSL/Docker 连接：先 state、再用户 agent 文件、最后只发一次重载", async () => {
    const wsl = connection({ kind: "wsl", distro: "Ubuntu" });
    const order: string[] = [];
    wsl.subagentsService.replaceSubagentState.mockImplementation(async () => {
      order.push("state");
      return authority.state;
    });
    wsl.subagentsService.replaceUserAgentFiles.mockImplementation(async () => {
      order.push("files");
      return authority.files;
    });
    wsl.zcodeAgentService.reloadSubagents.mockImplementation(async () => {
      order.push("reload");
    });

    const readAuthority = vi.fn(async () => authority);
    await pushSubagentConfigToRemoteHosts({
      connections: [wsl],
      readAuthority,
      onError: vi.fn(),
    });

    expect(readAuthority).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["state", "files", "reload"]);
    expect(wsl.subagentsService.replaceSubagentState).toHaveBeenCalledWith(authority.state);
    expect(wsl.subagentsService.replaceUserAgentFiles).toHaveBeenCalledWith(authority.files);
  });

  it("跳过 standalone server，且没有可推连接时不读本机权威", async () => {
    const serverConnection = connection(server);
    const readAuthority = vi.fn(async () => authority);
    await pushSubagentConfigToRemoteHosts({
      connections: [serverConnection],
      readAuthority,
      onError: vi.fn(),
    });
    expect(readAuthority).not.toHaveBeenCalled();
    expect(serverConnection.subagentsService.replaceSubagentState).not.toHaveBeenCalled();
  });

  it("读本机权威失败只上报，不向任何连接推", async () => {
    const sshConnection = connection(ssh);
    const onError = vi.fn();
    await expect(
      pushSubagentConfigToRemoteHosts({
        connections: [sshConnection],
        readAuthority: async () => {
          throw new Error("本机 agents-state.json 读失败");
        },
        onError,
      }),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(sshConnection.subagentsService.replaceSubagentState).not.toHaveBeenCalled();
    expect(sshConnection.zcodeAgentService.reloadSubagents).not.toHaveBeenCalled();
  });

  it("state 写不进去就放弃该连接：不写半份文件也不发重载，其它连接照常", async () => {
    const broken = connection(ssh);
    broken.subagentsService.replaceSubagentState.mockRejectedValue(new Error("断连"));
    const wsl = connection({ kind: "wsl", distro: "Ubuntu" });
    const onError = vi.fn();

    await pushSubagentConfigToRemoteHosts({
      connections: [broken, wsl],
      readAuthority: async () => authority,
      onError,
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(broken.subagentsService.replaceUserAgentFiles).not.toHaveBeenCalled();
    expect(broken.zcodeAgentService.reloadSubagents).not.toHaveBeenCalled();
    expect(wsl.subagentsService.replaceUserAgentFiles).toHaveBeenCalledWith(authority.files);
    expect(wsl.zcodeAgentService.reloadSubagents).toHaveBeenCalledTimes(1);
  });

  it("旧对端不认识 replaceUserAgentFiles 时只降级那一步，state 与重载照常", async () => {
    const oldRemote = connection(ssh);
    oldRemote.subagentsService.replaceUserAgentFiles.mockRejectedValue(
      new Error("Unknown method replaceUserAgentFiles"),
    );
    const onError = vi.fn();

    await pushSubagentConfigToRemoteHosts({
      connections: [oldRemote],
      readAuthority: async () => authority,
      onError,
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(oldRemote.subagentsService.replaceSubagentState).toHaveBeenCalledWith(authority.state);
    expect(oldRemote.zcodeAgentService.reloadSubagents).toHaveBeenCalledTimes(1);
  });

  it("重载通知失败不算复制失败（文件已落盘），只上报", async () => {
    const sshConnection = connection(ssh);
    sshConnection.zcodeAgentService.reloadSubagents.mockRejectedValue(new Error("Unknown command"));
    const onError = vi.fn();

    await pushSubagentConfigToRemoteHosts({
      connections: [sshConnection],
      readAuthority: async () => authority,
      onError,
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(sshConnection.subagentsService.replaceUserAgentFiles).toHaveBeenCalledWith(
      authority.files,
    );
  });
});
