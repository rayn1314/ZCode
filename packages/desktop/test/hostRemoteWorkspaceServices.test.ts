import { Emitter, ChannelClient, ChannelServer, createQueuePair, ProxyChannel } from "@zcode/rpc";
import { describe, expect, it, vi } from "vitest";
import {
  IBotsService,
  IBroadcastService,
  IClientConfigService,
  ICommandsService,
  ICredentialService,
  ICodingPlanSubscriptionService,
  IFileService,
  IGenUiService,
  IMcpSyncService,
  IMediaPreviewService,
  IModelSelectionService,
  IOAuthService,
  IOnboardingRecordService,
  IPluginSyncService,
  IPluginsService,
  IProjectService,
  IProviderSettingsService,
  IRemoteProjectService,
  ISettingService,
  ISettingsSyncService,
  ISkillSyncService,
  ISkillsService,
  ISourceServerWorkspaceService,
  ISubagentsService,
  ISystemService,
  ITaskGroupService,
  IUsageStatsService,
  type BroadcastMessage,
  type IServiceAccessor,
  ServiceCollection,
} from "@zcode/services";
import { REMOTE_WORKSPACE_RPC_CHANNELS } from "../src/host/remoteWorkspaceRpcContract.js";
import {
  REMOTE_WORKSPACE_RPC_REGISTRATIONS,
  createServerRemoteWorkspaceServiceCollection,
} from "../src/host/remoteWorkspaceServiceCollection.js";
import { getRemoteProviderProvisioningExecutor } from "../src/host/remoteProviderProvisioningService.js";
import {
  createSourceSettingsServiceCollection,
  shouldDetachSourceSettingsAttachment,
} from "../src/host/sourceSettingsServiceCollection.js";

const clientConfigService = { getSnapshot: vi.fn(async () => ({ pluginStoreOrder: null })) };

function makeServerRemoteServices(): IServiceAccessor {
  return {
    ...Object.fromEntries(
      REMOTE_WORKSPACE_RPC_CHANNELS.map((channel) => [channel, { remote: channel }]),
    ),
    systemService: { info: vi.fn(async () => ({ platform: "linux", homedir: "/home/remote" })) },
  } as unknown as IServiceAccessor;
}

function createBaseGenUiService() {
  return {
    readDocument: vi.fn(async () => ({ path: "", html: "" })),
    prepareSandbox: vi.fn(async () => ({}) as never),
    getState: vi.fn(async () => null),
    setState: vi.fn(async () => {}),
    listState: vi.fn(async () => []),
    onStateChanged: vi.fn(() => ({ dispose: () => {} })),
  };
}

function createOnboardingRecordStub(): IOnboardingRecordService {
  return {
    appendRecord: vi.fn(async () => {}),
    dismissOnboarding: vi.fn(async () => {}),
    claimAnonymousRecord: vi.fn(async () => {}),
    shouldOnboard: vi.fn(async () => false),
    getLatestEntry: vi.fn(async () => null),
    syncSettingsFromRecord: vi.fn(async () => null),
    updateRecordPreferences: vi.fn(async () => {}),
    getRecords: vi.fn(async () => null),
    clearRecords: vi.fn(async () => {}),
  };
}

describe("server remote workspace host service wiring", () => {
  it("keeps registrations equal to the RPC contract", () => {
    expect(REMOTE_WORKSPACE_RPC_REGISTRATIONS.map(([key]) => key).sort()).toEqual(
      [...REMOTE_WORKSPACE_RPC_CHANNELS].sort(),
    );
  });

  it.each(["ssh", "wsl", "docker", "server"] as const)(
    "%s 分组使用控制端服务和广播，执行服务仍归 Source",
    async (targetKind) => {
      const controllerEvents = new Emitter<BroadcastMessage>();
      const sourceEvents = new Emitter<BroadcastMessage>();
      const broadcast = (events: Emitter<BroadcastMessage>) => ({
        send: vi.fn(async (message: BroadcastMessage) => events.fire(message)),
        onMessage: events.event,
        acquireClaim: vi.fn(async () => ({ status: "unavailable" as const })),
        commitClaim: vi.fn(async () => {}),
        releaseClaim: vi.fn(async () => {}),
        tryClaim: vi.fn(async () => false),
      });
      const controllerBroadcast = broadcast(controllerEvents),
        sourceBroadcast = broadcast(sourceEvents);
      const groups = {
        read: vi.fn(async () => ({ groups: [], members: [], order: [] })),
        save: vi.fn(),
        move: vi.fn(),
        ungroup: vi.fn(),
        admit: vi.fn(),
      };
      const remoteServices = { ...makeServerRemoteServices(), broadcastService: sourceBroadcast };
      const services = createServerRemoteWorkspaceServiceCollection({
        clientConfigService,
        targetKind,
        connectionServices: remoteServices,
        sourceServices: new ServiceCollection()
          .register(ITaskGroupService, groups)
          .register(IBroadcastService, controllerBroadcast),
      });
      expect(services.get(ITaskGroupService)).toBe(groups);
      expect(services.get(IFileService)).toBe(remoteServices.fileService);
      const listener = vi.fn();
      const subscription = services.get(IBroadcastService).onMessage(listener);
      controllerEvents.fire({ channel: "state:task-groups", payload: {} });
      sourceEvents.fire({ channel: "state:task-groups", payload: {} });
      sourceEvents.fire({ channel: "state:projects", payload: {} });
      expect(listener.mock.calls.map(([event]) => event.channel)).toEqual([
        "state:task-groups",
        "state:projects",
      ]);
      subscription.dispose();
      controllerEvents.fire({ channel: "state:task-groups", payload: {} });
      expect(listener).toHaveBeenCalledTimes(2);
      controllerEvents.dispose();
      sourceEvents.dispose();
    },
  );

  it("detaches Source settings while updating", () => {
    expect(shouldDetachSourceSettingsAttachment("online")).toBe(false);
    expect(shouldDetachSourceSettingsAttachment("updating")).toBe(true);
  });

  it("exposes only non-provider configuration channels for a Source settings attachment", () => {
    const remoteServices = makeServerRemoteServices();
    const services = createSourceSettingsServiceCollection(remoteServices);

    expect(services.get(ICredentialService)).toBe(remoteServices.credentialService);
    expect(services.get(IOAuthService)).toBe(remoteServices.oauthService);
    expect(services.get(ICodingPlanSubscriptionService)).toBe(
      remoteServices.codingPlanSubscriptionService,
    );
    expect(services.get(ISettingService)).toBe(remoteServices.settingService);
    expect(services.get(ISystemService)).toBe(remoteServices.systemService);
    expect(services.get(IPluginSyncService)).toBe(remoteServices.pluginSyncService);
    expect(services.get(IPluginsService)).toBe(remoteServices.pluginsService);
    expect(services.get(ISubagentsService)).toBe(remoteServices.subagentsService);
    expect(services.get(ISettingsSyncService)).toBe(remoteServices.settingsSyncService);
    // 模型设置页永远绑定本地 Environment，远端 Provider 事实只经 Provisioning 单向下发，
    // 不再借 source-settings attachment 暴露给设置页编辑。
    expect(services.getOptional(IProviderSettingsService)).toBeUndefined();
    expect(services.getOptional(IModelSelectionService)).toBeUndefined();
    expect(services.getOptional(IFileService)).toBeUndefined();
  });

  it("keeps the Source Server runtime authoritative for every forwarded service family", () => {
    const remoteServices = makeServerRemoteServices();
    const services = createServerRemoteWorkspaceServiceCollection({
      clientConfigService,
      targetKind: "server",
      connectionServices: remoteServices,
    });

    expect(services.get(IClientConfigService)).toBe(clientConfigService);
    expect(services.get(IFileService)).toBe(remoteServices.fileService);
    expect(services.get(IMediaPreviewService)).toBe(remoteServices.mediaPreviewService);
    expect(services.get(ISettingService)).toBe(remoteServices.settingService);
    expect(services.get(IOnboardingRecordService)).toBe(remoteServices.onboardingRecordService);
    expect(services.get(ICredentialService)).toBe(remoteServices.credentialService);
    expect(services.get(IBroadcastService)).toBe(remoteServices.broadcastService);
    expect(services.get(IBotsService)).toBe(remoteServices.botsService);
    expect(services.get(IOAuthService)).toBe(remoteServices.oauthService);
    expect(services.get(IProviderSettingsService)).toBe(remoteServices.providerSettingsService);
    expect(services.get(IModelSelectionService)).toBe(remoteServices.modelSelectionService);
    expect(services.get(ISourceServerWorkspaceService)).toBe(
      remoteServices.sourceServerWorkspaceService,
    );
    expect(services.get(IUsageStatsService)).toBe(remoteServices.usageStatsService);
    expect(services.get(ISkillsService)).toBe(remoteServices.skillsService);
    expect(services.get(ISkillSyncService)).toBe(remoteServices.skillSyncService);
    expect(services.get(IMcpSyncService)).toBe(remoteServices.mcpSyncService);
    expect(services.get(IPluginSyncService)).toBe(remoteServices.pluginSyncService);
    expect(services.get(IPluginsService)).toBe(remoteServices.pluginsService);
    expect(services.get(ISubagentsService)).toBe(remoteServices.subagentsService);
    expect(services.get(ICommandsService)).toBe(remoteServices.commandsService);
    expect(services.get(ISettingsSyncService)).toBe(remoteServices.settingsSyncService);
  });

  it("routes Gen UI reads to the executor host and keeps widget state on the desktop base", async () => {
    const readDocument = vi.fn(async () => ({ path: "/home/u/v/a.html", html: "<p>remote</p>" }));
    const remoteServices = {
      ...makeServerRemoteServices(),
      genUiService: { readDocument },
    } as unknown as IServiceAccessor;
    const baseGenUi = createBaseGenUiService();
    const sourceServices = new ServiceCollection().register(IGenUiService, baseGenUi as never);
    const services = createServerRemoteWorkspaceServiceCollection({
      clientConfigService,
      targetKind: "server",
      connectionServices: remoteServices,
      sourceServices,
    });
    const genUi = services.get(IGenUiService);
    const target = {
      workspacePath: "/home/u/ws",
      workspaceIdentity: "remote:server:1:/home/u/ws",
      sessionId: "sess-1",
      path: "/home/u/.zcode-rayn/v2/visualizations/hash/a.html",
    };

    await expect(genUi.readDocument(target)).resolves.toEqual({
      path: "/home/u/v/a.html",
      html: "<p>remote</p>",
    });
    expect(readDocument).toHaveBeenCalledWith(target);
    expect(baseGenUi.readDocument).not.toHaveBeenCalled();

    await genUi.getState(target);
    await genUi.setState({ target, state: { modelContent: null, privateContent: null } });
    await genUi.listState({ workspacePath: target.workspacePath, sessionId: "sess-1" });
    expect(baseGenUi.getState).toHaveBeenCalled();
    expect(baseGenUi.setState).toHaveBeenCalled();
    expect(baseGenUi.listState).toHaveBeenCalled();
  });

  it("fails closed when the remote executor has no gen-ui channel", async () => {
    // 契约里的 genUiService 只有 channel 名（旧 Server 没有 readDocument 能力）：
    // 包装器必须拒绝读取，不能回落到本机 base。
    const remoteServices = makeServerRemoteServices();
    const baseGenUi = createBaseGenUiService();
    const services = createServerRemoteWorkspaceServiceCollection({
      clientConfigService,
      targetKind: "server",
      connectionServices: remoteServices,
      sourceServices: new ServiceCollection().register(IGenUiService, baseGenUi as never),
    });

    await expect(
      services.get(IGenUiService).readDocument({
        workspacePath: "/home/u/ws",
        sessionId: "sess-1",
        path: "/home/u/ws/a.html",
      }),
    ).rejects.toThrow("remote executor does not expose gen-ui");
    // 绝不能回落到本机读：那正是 A2 的失败形态。
    expect(baseGenUi.readDocument).not.toHaveBeenCalled();
  });

  it.each(["ssh", "wsl", "docker", "server"] as const)(
    "%s 远程 attachment 通过 RPC 访问 Source 自己的引导记录并保留服务错误",
    async (targetKind) => {
      // R3 下 settings/OAuth 均由 Source 全转发；引导记录必须同源，不能借用本机 Local Host 记录。
      const localRecord = createOnboardingRecordStub();
      const sourceRecord = createOnboardingRecordStub();
      const services = createServerRemoteWorkspaceServiceCollection({
        clientConfigService,
        targetKind,
        connectionServices: {
          ...makeServerRemoteServices(),
          onboardingRecordService: sourceRecord,
        },
        sourceServices: new ServiceCollection().register(IOnboardingRecordService, localRecord),
      });
      const [serverProtocol, clientProtocol] = createQueuePair();
      const server = new ChannelServer(serverProtocol, "mobile-onboarding", 50);
      const client = new ChannelClient(clientProtocol);
      services.exposeOnChannelServer(server);
      const record = ProxyChannel.toService<IOnboardingRecordService>(
        client.getChannel(IOnboardingRecordService.channelName),
      );
      try {
        // 远程集合曾漏注册通道；即使 owner 已有记录，手机也只能收到 Unknown channel。
        await record.claimAnonymousRecord();
        await expect(record.shouldOnboard("mobile-device")).resolves.toBe(false);
        await record.dismissOnboarding("mobile-device");
        const entry = {
          occupation: "developer",
          interfaceMode: "coding" as const,
          memoryEnabled: false,
          proactiveSuggestionsEnabled: false,
          completedAt: "2026-10-09T00:00:00.000Z",
        };
        await record.appendRecord("mobile-device", entry);
        expect(services.get(IOnboardingRecordService)).toBe(sourceRecord);
        expect(sourceRecord.dismissOnboarding).toHaveBeenCalledWith("mobile-device");
        expect(sourceRecord.appendRecord).toHaveBeenCalledWith("mobile-device", entry);
        expect(localRecord.claimAnonymousRecord).not.toHaveBeenCalled();
        expect(localRecord.shouldOnboard).not.toHaveBeenCalled();
        expect(localRecord.dismissOnboarding).not.toHaveBeenCalled();
        expect(localRecord.appendRecord).not.toHaveBeenCalled();
        vi.mocked(sourceRecord.shouldOnboard).mockRejectedValueOnce(
          new Error("record read failed"),
        );
        await expect(record.shouldOnboard("mobile-device")).rejects.toThrow("record read failed");
      } finally {
        client.dispose();
        server.dispose();
      }
    },
  );

  it("旧 Server 通过原文件与系统频道浏览目录并保留远端路径规则", async () => {
    const remoteServices = makeServerRemoteServices();
    const entries = [{ name: "repo", path: "C:\\Users\\remote\\repo", type: "directory" }];
    const readdir = vi.fn(async () => entries);
    remoteServices.fileService = { readdir } as unknown as IFileService;
    remoteServices.systemService = {
      info: vi.fn(async () => ({ platform: "win32", homedir: "C:\\Users\\remote" })),
    } as unknown as ISystemService;
    const services = createServerRemoteWorkspaceServiceCollection({
      connectionServices: remoteServices,
      serverId: "old",
    });
    const projectService = services.get(IProjectService);
    await expect(projectService.readDirectory()).resolves.toEqual({
      path: "C:\\Users\\remote",
      entries,
    });
    await expect(
      projectService.readDirectory({ path: "C:/repo/../work", includeHidden: true }),
    ).resolves.toEqual({ path: "C:\\work", entries });
    expect(readdir).toHaveBeenLastCalledWith({ path: "C:\\work", includeHidden: true });
    await expect(projectService.readDirectory({ path: "C:relative" })).rejects.toThrow(
      "project.absolute-path-required",
    );
    await expect(projectService.saveProject({ roots: ["C:\\work"] })).rejects.toThrow(
      "project.legacy-read-only",
    );
  });

  it("旧 Server 没有目录历史时仍可按本机保留入口寻址，刷新不会创建新入口", async () => {
    const remoteServices = makeServerRemoteServices();
    remoteServices.settingService = {
      get: vi.fn(async () => ({ lastWorkspaceSession: [], recentProjects: [] })),
    } as unknown as typeof remoteServices.settingService;
    let entries = [
      { hostId: "remote:server:old", roots: [{ rootPath: "/retained" }], legacyWorkspace: null },
    ];
    const sourceServices = new ServiceCollection().register(IRemoteProjectService, {
      readDirectory: vi.fn(async () => ({ hosts: [], entries })),
    } as unknown as IRemoteProjectService);
    const services = createServerRemoteWorkspaceServiceCollection({
      connectionServices: remoteServices,
      serverId: "old",
      sourceServices,
    });
    expect((await services.get(IProjectService).readProjects())[0]?.roots[0]?.rootPath).toBe(
      "/retained",
    );
    entries = [];
    expect(await services.get(IProjectService).readProjects()).toEqual([]);
  });
  it("缺少握手能力时忽略未知频道 proxy，通过旧 API 提供单 root 项目", async () => {
    const remoteServices = makeServerRemoteServices();
    const unsupportedRead = vi.fn(async () => {
      throw new Error("Unknown channel");
    });
    remoteServices.projectService = { readProjects: unsupportedRead } as unknown as IProjectService;
    remoteServices.settingService = {
      get: vi.fn(async () => ({
        lastWorkspaceSession: [{ kind: "local", workspacePath: "/remote/root" }],
        recentProjects: [],
      })),
    } as unknown as typeof remoteServices.settingService;
    const services = createServerRemoteWorkspaceServiceCollection({
      connectionServices: remoteServices,
      serverId: "old",
    });
    expect(await services.get(IProjectService).readProjects()).toEqual([
      expect.objectContaining({
        hostId: "remote:server:old",
        legacySingleRoot: true,
        roots: [{ rootPath: "/remote/root", position: 0, isPrimary: true }],
      }),
    ]);
    expect(unsupportedRead).not.toHaveBeenCalled();
    await expect(services.get(IRemoteProjectService).readDirectory()).resolves.toEqual({
      hosts: [],
      entries: [],
    });
  });
  it("forwards declared virtual-project channels without adding them to the v1 requirement", () => {
    const remoteServices = Object.assign(makeServerRemoteServices(), {
      projectService: { readTree: vi.fn() },
      remoteProjectService: { readDirectory: vi.fn() },
    });
    const modern = createServerRemoteWorkspaceServiceCollection({
      connectionServices: remoteServices as unknown as IServiceAccessor,
      virtualProjects: true,
    });
    expect(modern.get(IProjectService)).toBe(remoteServices.projectService);
    expect(modern.get(IRemoteProjectService)).toBe(remoteServices.remoteProjectService);
    const legacy = createServerRemoteWorkspaceServiceCollection({
      connectionServices: remoteServices as unknown as IServiceAccessor,
    });
    expect(legacy.getOptional(IProjectService)).toBeUndefined();
    expect(REMOTE_WORKSPACE_RPC_CHANNELS).not.toContain("projectService");
  });
  it("reuses URL registry services for configuration without exposing task/runtime channels", () => {
    const remoteServices = makeServerRemoteServices();
    const registry = createServerRemoteWorkspaceServiceCollection({
      connectionServices: remoteServices,
    });
    const settings = createSourceSettingsServiceCollection(registry);
    expect(settings.get(ISubagentsService)).toBe(remoteServices.subagentsService);
    expect(settings.getOptional(IProjectService)).toBeUndefined();
    expect(settings.getOptional(IFileService)).toBeUndefined();
  });

  it("registers a host-private provider provisioning executor for every Source connection", async () => {
    const remoteTargetApply = vi.fn();
    const remoteServices = Object.assign(makeServerRemoteServices(), {
      providerProvisioningTargetService: { apply: remoteTargetApply },
    });
    const services = createServerRemoteWorkspaceServiceCollection({
      clientConfigService,
      targetKind: "server",
      connectionServices: remoteServices,
    });

    const executor = getRemoteProviderProvisioningExecutor(services);
    expect(executor).toBeDefined();
    // 没有本机 Provisioning Source 时必须 fail-closed 为 unsupported，不能向远端发送半份快照。
    await expect(executor!.syncLocalToRemote()).resolves.toMatchObject({
      status: "unsupported",
      rolledBack: false,
    });
    expect(remoteTargetApply).not.toHaveBeenCalled();
  });
});
