import { IGenUiService } from "@zcode/services";
import { ProxyChannel, type IChannelClient } from "@zcode/rpc";
import {
  IFileService,
  IMediaPreviewService,
  IGitService,
  IGitCheckpointService,
  ISystemService,
  ITerminalService,
  ISettingService,
  IOnboardingRecordService,
  ICredentialService,
  IBroadcastService,
  IZCodeTaskService,
  IZCodeAgentService,
  IZCodeSessionService,
  ICuaPermissionService,
  IConversationShareService,
  IBotsService,
  IFileWatcherService,
  IOAuthService,
  IModelSelectionService,
  IProviderSettingsService,
  IProviderProvisioningTargetService,
  IUsageStatsService,
  IUsageLedgerService,
  IMigrationService,
  ICodingPlanSubscriptionService,
  IClientConfigService,
  IClientScenesService,
  ICloudContentService,
  IMarketingTouchService,
  IOffPeakTaskService,
  IHighspeedCardService,
  ISkillsService,
  ISkillSyncService,
  IMcpSyncService,
  IPluginUiAppToolsService,
  IPluginUiSamplingService,
  IPluginUiBridgeService,
  IPluginSyncService,
  IPluginsService,
  IPluginManagementService,
  ISubagentsService,
  ICommandsService,
  IHooksService,
  IMemoryService,
  IInstructionsService,
  IOutputStyleService,
  ISettingsSyncService,
  IFeedbackService,
  IPromptAttachmentTransferService,
  IWindowControllerService,
  type IServiceAccessor,
} from "@zcode/services";

/**
 * RemoteServiceAccess — 通过 ChannelClient 自动创建类型安全的服务代理
 *
 * 新增服务只需在此添加一个 getter。
 */
export class RemoteServiceAccess implements IServiceAccessor {
  readonly fileService: IFileService;
  readonly mediaPreviewService: IMediaPreviewService;
  readonly gitService: IGitService;
  readonly gitCheckpointService: IGitCheckpointService;
  readonly systemService: ISystemService;
  readonly terminalService: ITerminalService;
  readonly settingService: ISettingService;
  readonly onboardingRecordService: IOnboardingRecordService;
  readonly credentialService: ICredentialService;
  readonly broadcastService: IBroadcastService;
  readonly zcodeTaskService: IZCodeTaskService;
  readonly windowControllerService: IWindowControllerService;
  readonly zcodeAgentService: IZCodeAgentService;
  readonly zcodeSessionService: IZCodeSessionService;
  // cuaPermissionService 在 IServiceAccessor 上是可选（远端/bots host 不提供），但桌面 renderer
  // 经 RPC 一定能拿到（main host 始终注册此 descriptor；非 macOS / 未启用时方法返回 available:false）。
  readonly cuaPermissionService: ICuaPermissionService;
  readonly conversationShareService: IConversationShareService;
  readonly botsService: IBotsService;
  readonly fileWatcherService: IFileWatcherService;
  readonly oauthService: IOAuthService;
  readonly providerSettingsService: IProviderSettingsService;
  readonly modelSelectionService: IModelSelectionService;
  /** Host-only target proxy；不属于 IServiceAccessor，避免向 Renderer 暴露 Secret 写入接口。 */
  readonly providerProvisioningTargetService!: IProviderProvisioningTargetService;
  readonly usageStatsService: IUsageStatsService;
  // 用量账本只在桌面本地 host 注册；远端 workspace 的 host 没有此 descriptor，
  // 代理调用会 reject，账本面板需捕获并显示「当前环境不支持」。
  readonly usageLedgerService: IUsageLedgerService;
  // 迁移服务由 createLocalServices 统一注册，本地与远端 host 都有此 descriptor；
  // 设置页固定用本地 host 渲染迁移面板（见 packages/services/spec/identity-data-migration.md）。
  readonly migrationService: IMigrationService;
  readonly codingPlanSubscriptionService: ICodingPlanSubscriptionService;
  readonly clientConfigService: IClientConfigService;
  readonly clientScenesService: IClientScenesService;
  readonly cloudContentService: ICloudContentService;
  readonly marketingTouchService: IMarketingTouchService;
  readonly offPeakTaskService: IOffPeakTaskService;
  readonly highspeedCardService: IHighspeedCardService;
  readonly skillsService: ISkillsService;
  readonly skillSyncService: ISkillSyncService;
  readonly mcpSyncService: IMcpSyncService;
  readonly genUiService: IGenUiService;
  readonly pluginUiBridgeService: IPluginUiBridgeService;
  readonly pluginUiSamplingService: IPluginUiSamplingService;
  readonly pluginUiAppToolsService: IPluginUiAppToolsService;
  readonly pluginSyncService: IPluginSyncService;
  readonly pluginsService: IPluginsService;
  readonly pluginManagementService: IPluginManagementService;
  readonly subagentsService: ISubagentsService;
  readonly commandsService: ICommandsService;
  readonly hooksService: IHooksService;
  readonly memoryService: IMemoryService;
  // 指令文件的读写永远发生在文件真正所在的机器：这里只是到目标 host 的通道代理。
  readonly instructionsService: IInstructionsService;
  readonly outputStyleService: IOutputStyleService;
  readonly settingsSyncService: ISettingsSyncService;
  readonly feedbackService: IFeedbackService;
  readonly promptAttachmentTransferService: IPromptAttachmentTransferService;

  constructor(channelClient: IChannelClient) {
    this.fileService = ProxyChannel.toService<IFileService>(
      channelClient.getChannel(IFileService.channelName),
    );
    // Host 已注册 media-preview channel，但遗漏 renderer proxy 时，PreviewPane
    // 会静默回退到 8 MiB 的 file.readMediaPreview，导致大 MP4 无法打开。
    this.mediaPreviewService = ProxyChannel.toService<IMediaPreviewService>(
      channelClient.getChannel(IMediaPreviewService.channelName),
    );
    this.gitService = ProxyChannel.toService<IGitService>(
      channelClient.getChannel(IGitService.channelName),
    );
    this.gitCheckpointService = ProxyChannel.toService<IGitCheckpointService>(
      channelClient.getChannel(IGitCheckpointService.channelName),
    );
    this.systemService = ProxyChannel.toService<ISystemService>(
      channelClient.getChannel(ISystemService.channelName),
    );
    this.terminalService = ProxyChannel.toService<ITerminalService>(
      channelClient.getChannel(ITerminalService.channelName),
    );
    this.settingService = ProxyChannel.toService<ISettingService>(
      channelClient.getChannel(ISettingService.channelName),
    );
    this.onboardingRecordService = ProxyChannel.toService<IOnboardingRecordService>(
      channelClient.getChannel(IOnboardingRecordService.channelName),
    );
    this.credentialService = ProxyChannel.toService<ICredentialService>(
      channelClient.getChannel(ICredentialService.channelName),
    );
    this.broadcastService = ProxyChannel.toService<IBroadcastService>(
      channelClient.getChannel(IBroadcastService.channelName),
    );
    this.zcodeTaskService = ProxyChannel.toService<IZCodeTaskService>(
      channelClient.getChannel(IZCodeTaskService.channelName),
    );
    this.windowControllerService = ProxyChannel.toService<IWindowControllerService>(
      channelClient.getChannel(IWindowControllerService.channelName),
    );
    this.zcodeAgentService = ProxyChannel.toService<IZCodeAgentService>(
      channelClient.getChannel(IZCodeAgentService.channelName),
    );
    this.zcodeSessionService = ProxyChannel.toService<IZCodeSessionService>(
      channelClient.getChannel(IZCodeSessionService.channelName),
    );
    this.cuaPermissionService = ProxyChannel.toService<ICuaPermissionService>(
      channelClient.getChannel(ICuaPermissionService.channelName),
    );
    this.conversationShareService = ProxyChannel.toService<IConversationShareService>(
      channelClient.getChannel(IConversationShareService.channelName),
    );
    this.botsService = ProxyChannel.toService<IBotsService>(
      channelClient.getChannel(IBotsService.channelName),
    );
    this.fileWatcherService = ProxyChannel.toService<IFileWatcherService>(
      channelClient.getChannel(IFileWatcherService.channelName),
    );
    this.oauthService = ProxyChannel.toService<IOAuthService>(
      channelClient.getChannel(IOAuthService.channelName),
    );
    this.providerSettingsService = ProxyChannel.toService<IProviderSettingsService>(
      channelClient.getChannel(IProviderSettingsService.channelName),
    );
    this.modelSelectionService = ProxyChannel.toService<IModelSelectionService>(
      channelClient.getChannel(IModelSelectionService.channelName),
    );
    Object.defineProperty(this, "providerProvisioningTargetService", {
      value: ProxyChannel.toService<IProviderProvisioningTargetService>(
        channelClient.getChannel(IProviderProvisioningTargetService.channelName),
      ),
      enumerable: false,
    });
    this.usageStatsService = ProxyChannel.toService<IUsageStatsService>(
      channelClient.getChannel(IUsageStatsService.channelName),
    );
    this.usageLedgerService = ProxyChannel.toService<IUsageLedgerService>(
      channelClient.getChannel(IUsageLedgerService.channelName),
    );
    this.migrationService = ProxyChannel.toService<IMigrationService>(
      channelClient.getChannel(IMigrationService.channelName),
    );
    this.codingPlanSubscriptionService = ProxyChannel.toService<ICodingPlanSubscriptionService>(
      channelClient.getChannel(ICodingPlanSubscriptionService.channelName),
    );
    this.clientConfigService = ProxyChannel.toService<IClientConfigService>(
      channelClient.getChannel(IClientConfigService.channelName),
    );
    this.clientScenesService = ProxyChannel.toService<IClientScenesService>(
      channelClient.getChannel(IClientScenesService.channelName),
    );
    this.cloudContentService = ProxyChannel.toService<ICloudContentService>(
      channelClient.getChannel(ICloudContentService.channelName),
    );
    this.marketingTouchService = ProxyChannel.toService<IMarketingTouchService>(
      channelClient.getChannel(IMarketingTouchService.channelName),
    );
    this.offPeakTaskService = ProxyChannel.toService<IOffPeakTaskService>(
      channelClient.getChannel(IOffPeakTaskService.channelName),
    );
    this.highspeedCardService = ProxyChannel.toService<IHighspeedCardService>(
      channelClient.getChannel(IHighspeedCardService.channelName),
    );
    this.skillsService = ProxyChannel.toService<ISkillsService>(
      channelClient.getChannel(ISkillsService.channelName),
    );
    this.skillSyncService = ProxyChannel.toService<ISkillSyncService>(
      channelClient.getChannel(ISkillSyncService.channelName),
    );
    this.mcpSyncService = ProxyChannel.toService<IMcpSyncService>(
      channelClient.getChannel(IMcpSyncService.channelName),
    );
    this.genUiService = ProxyChannel.toService<IGenUiService>(
      channelClient.getChannel(IGenUiService.channelName),
    );
    this.pluginUiBridgeService = ProxyChannel.toService<IPluginUiBridgeService>(
      channelClient.getChannel(IPluginUiBridgeService.channelName),
    );
    this.pluginUiSamplingService = ProxyChannel.toService<IPluginUiSamplingService>(
      channelClient.getChannel(IPluginUiSamplingService.channelName),
    );
    this.pluginUiAppToolsService = ProxyChannel.toService<IPluginUiAppToolsService>(
      channelClient.getChannel(IPluginUiAppToolsService.channelName),
    );
    this.pluginSyncService = ProxyChannel.toService<IPluginSyncService>(
      channelClient.getChannel(IPluginSyncService.channelName),
    );
    this.pluginsService = ProxyChannel.toService<IPluginsService>(
      channelClient.getChannel(IPluginsService.channelName),
    );
    this.pluginManagementService = ProxyChannel.toService<IPluginManagementService>(
      channelClient.getChannel(IPluginManagementService.channelName),
    );
    this.subagentsService = ProxyChannel.toService<ISubagentsService>(
      channelClient.getChannel(ISubagentsService.channelName),
    );
    this.commandsService = ProxyChannel.toService<ICommandsService>(
      channelClient.getChannel(ICommandsService.channelName),
    );
    this.hooksService = ProxyChannel.toService<IHooksService>(
      channelClient.getChannel(IHooksService.channelName),
    );
    this.memoryService = ProxyChannel.toService<IMemoryService>(
      channelClient.getChannel(IMemoryService.channelName),
    );
    this.instructionsService = ProxyChannel.toService<IInstructionsService>(
      channelClient.getChannel(IInstructionsService.channelName),
    );
    this.outputStyleService = ProxyChannel.toService<IOutputStyleService>(
      channelClient.getChannel(IOutputStyleService.channelName),
    );
    this.settingsSyncService = ProxyChannel.toService<ISettingsSyncService>(
      channelClient.getChannel(ISettingsSyncService.channelName),
    );
    this.feedbackService = ProxyChannel.toService<IFeedbackService>(
      channelClient.getChannel(IFeedbackService.channelName),
    );
    this.promptAttachmentTransferService = ProxyChannel.toService<IPromptAttachmentTransferService>(
      channelClient.getChannel(IPromptAttachmentTransferService.channelName),
    );
  }
}
