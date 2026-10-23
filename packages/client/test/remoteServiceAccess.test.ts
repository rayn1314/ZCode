import { describe, expect, it, vi } from "vitest";
import type { IChannel, IChannelClient } from "@zcode/rpc";
import {
  IClientConfigService,
  IInstructionsService,
  IMediaPreviewService,
  IMigrationService,
  ISourceServerManagementService,
} from "@zcode/services";
import { RemoteServiceAccess } from "../src/remoteServiceAccess.js";

const channel: IChannel = {
  call: vi.fn(),
  listen: vi.fn(),
};

describe("RemoteServiceAccess", () => {
  it("公开配置经独立频道 RPC 读取", async () => {
    const call = vi.fn(async () => ({ pluginStoreOrder: null }));
    const requested: string[] = [];
    const services = new RemoteServiceAccess({
      getChannel: (name) => {
        requested.push(name);
        return { call, listen: vi.fn() } as IChannel;
      },
    });
    expect(await services.clientConfigService.getSnapshot({ forceRefresh: true })).toEqual({
      pluginStoreOrder: null,
    });
    expect(requested).toContain("client-config");
    expect(call.mock.calls[0]?.slice(0, 2)).toEqual(["getSnapshot", [{ forceRefresh: true }]]);
  });

  // 保留本地回归：媒体预览必须每条远端连接都建代理，缺了会静默回退到 8 MiB 的
  // file.readMediaPreview，大 MP4 打不开。
  it("creates the media preview proxy for every remote service connection", () => {
    const channelNames: string[] = [];
    const channel: IChannel = {
      call: vi.fn(),
      listen: vi.fn(),
    };
    const channelClient: IChannelClient = {
      getChannel: (channelName) => {
        channelNames.push(channelName);
        return channel;
      },
    };

    const services = new RemoteServiceAccess(channelClient);

    expect(channelNames).toContain(IMediaPreviewService.channelName);
    expect(services.mediaPreviewService).toBeDefined();
    expect(channelNames).toContain(IClientConfigService.channelName);
    expect(services.clientConfigService).toBeDefined();
  });
});

describe("RemoteServiceAccess optional channels", () => {
  it("does not construct a Source management proxy for scopes that do not publish it", () => {
    const getChannel = vi.fn(() => channel);
    const services = new RemoteServiceAccess({ getChannel } as IChannelClient, {
      sourceServerManagementService: false,
    });

    expect(services.sourceServerManagementService).toBeUndefined();
    expect(getChannel).not.toHaveBeenCalledWith(ISourceServerManagementService.channelName);
  });
  it("creates the instructions proxy so the settings page can reach the host that owns the file", () => {
    const channelNames: string[] = [];
    const channel: IChannel = {
      call: vi.fn(),
      listen: vi.fn(),
    };
    const channelClient: IChannelClient = {
      getChannel: (channelName) => {
        channelNames.push(channelName);
        return channel;
      },
    };

    const services = new RemoteServiceAccess(channelClient);

    expect(channelNames).toContain(IInstructionsService.channelName);
    expect(IInstructionsService.channelName).toBe("instructions");
    expect(services.instructionsService).toBeDefined();
  });
  it("creates the identity data migration proxy so the settings page can reach the local host", () => {
    const channelNames: string[] = [];
    const channel: IChannel = {
      call: vi.fn(),
      listen: vi.fn(),
    };
    const channelClient: IChannelClient = {
      getChannel: (channelName) => {
        channelNames.push(channelName);
        return channel;
      },
    };

    const services = new RemoteServiceAccess(channelClient);

    expect(channelNames).toContain(IMigrationService.channelName);
    expect(IMigrationService.channelName).toBe("migration");
    expect(services.migrationService).toBeDefined();
  });
});

it("MRO02：窗口目录只由显式能力创建，原工作区 project 频道保留", async () => {
  const calls: string[] = [];
  const getChannel = vi.fn((name: string) => ({
    call: async () => {
      calls.push(name);
      return name === "window-project-changes" ? { version: 1 } : { projects: [], tasks: [] };
    },
    listen: vi.fn(),
  }));
  const legacy = new RemoteServiceAccess({ getChannel });
  expect(legacy.windowProjectDirectory).toBeUndefined();
  expect(getChannel).not.toHaveBeenCalledWith("window-project");
  const services = new RemoteServiceAccess({ getChannel }, { windowProjectDirectory: true });
  expect(services.windowProjectDirectory).toBeDefined();
  await services.windowProjectDirectory!.changesService.getCapabilities();
  await services.windowProjectDirectory!.projectService.readTree();
  await services.projectService.readTree();
  expect(calls).toEqual(["window-project-changes", "window-project", "project"]);
});
