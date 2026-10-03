# 身份数据迁移（spec）

涉及包：`packages/services`（主责：来源根探测、迁移服务、逐域实现）、`packages/shared`（服务频道名）、
`packages/ui`（设置节与引导入口）。

身份归属总表见 `packages/desktop/spec/product-identity-data-root.md`；本节只描述"把另一个身份
数据根里的数据搬进当前身份"的规则。

## 背景与问题

同一台机器上并排安装官方版与自建版后，两个身份各有数据根（官方 `{home}/.zcode`、自建
`{home}/.zcode-<身份>`，见身份归属总表）。用户从官方切到自建（或反向）时，需要把既有数据带过去，
当前只能手工 `robocopy` / `cp -r`：

1. **无法选域**：要么整根拷贝（把对方日志、崩溃 dump、mailbox、制品一并搬进新身份），要么不搬。
2. **无冲突语义**：目录级覆盖会把目标身份已有的 `setting.json`、库文件直接盖掉，是否"合并"、
   "跳过"、"失败回滚"全凭命令行行为，不可预期。
3. **易错且不可复核**：SQLite 有 `-wal` / `-shm`，运行中拷主库文件会拿到半截状态；
   `credentials.json` 是密文但两代密钥派生不同源，直接抄文件可能解不开或双重加密。
4. **凭据与信任被当成普通文件**：信任记录是权限边界，跨身份复制等于替用户做了授权决定。

本轮把这件事做成产品能力：在设置里按**域**（domain）粒度勾选迁移，每域有固定策略、有冲突计数、
有失败语义，且来源根自动探测（不是写死官方）。

## 设计决策

- **按域粒度，域内策略固定**：不给"是否覆盖"开关。破坏性写操作默认最少惊讶——目标已有的一律
  跳过或整域跳过，需要覆盖时用户先自行删除目标文件。
- **六个可迁移域，四个判据决定归属**（沿用身份归属总表的四域判据：身份隔离域 / 用户资产共享域 /
  跨机可达域 / 制品域）：

| id                 | 名称           | 源 → 目标                                                                                  | 策略                                                                                    | 默认勾选 |
| ------------------ | -------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | -------- |
| `appSettings`      | 界面与通用设置 | `{src}/v2/setting.json` → 目标身份                                                         | 只搬显式偏好白名单字段（见下），源里没写的不动目标；**剔除 `dataBaseDir` 与迁移哨兵位** | 是       |
| `providerConfig`   | 服务商配置     | `{src}/v2/provider_config.json` → `{dataRoot}/v2/provider_config.json`                     | zod 校验通过才写；目标已存在则整域跳过                                                  | 是       |
| `credentials`      | 登录凭据       | `{src}/v2/credentials.json` → 目标身份                                                     | 逐 key：目标已有跳过；缺失项解密后经 `ICredentialService.save` 写入（目标侧重新加密）   | 否       |
| `sessions`         | 会话与任务历史 | `{src}/v2/tasks-index.sqlite`、`{src}/v2/sessions/**`、`{src}/cli/db/db.sqlite` → 目标身份 | SQLite 走 `VACUUM INTO` 快照再落位；其余逐文件补缺失；**目标已存在一律跳过，绝不覆盖**  | 否       |
| `workflows`        | 用户级工作流   | `{src}/workflows/*` → `{dataRoot}/workflows/`                                              | 逐文件同名跳过；`.dwf.ts`（动态）与 `.workflow.js`（legacy）两代同收                    | 是       |
| `hookDeclarations` | hooks 声明     | `{src}/cli/config.json` 的 `hooks` 字段 → 目标身份同文件                                   | 按事件名 + matcher 合并，同名跳过；写回保留目标其它字段（`plugins` / `skills` 开关等）  | 是       |

`appSettings` 的写入面是**显式白名单**，不是"除 `dataBaseDir` 外的全部字段"。三类必须剔除：

1. **引导指针 `dataBaseDir`**：它是数据根本身（`desktopDataBaseDirBootstrap` 读它、`settingService.updateDataBaseDir`
   写它），不是用户偏好。把源身份的 `dataBaseDir` 带进来会把目标身份重定向到源数据根，等价于迁移把
   自己搬没了。
2. **迁移哨兵位**：`closeToTrayOnWindowsMigrationInitialized`、`messageStreamShowReasoningMigrationInitialized`、
   `providerFamilyDomainMigrated`、`settingsSyncFirstRunPromptHandled`。布尔含义是"**本安装**的
   schema 迁移已跑过"。跨身份搬过去会让目标跳过自己的迁移步骤。
3. **机器/工作区状态与账号绑定**：`recentProjects`、`lastWorkspaceSession`、`lastActiveTabIndex`、
   `lastActiveTaskByWorkspace`（指向源身份下打开过的工作区路径）、`providerFamilyDomain` /
   `providerFamilyConnectionSelections` / `providerFamilyDomainUpdatedAt`（账号与订阅绑定，
   服务商配置域已单独处理）、`skippedElectronUpdateVersions`（与当前安装的版本序列相关）、
   `pendingPostUpdateReleaseNotes`（一次性中间态）。

搬的是：`locale`、`localePreference`、`shortcutBindings`、`terminalInheritSystemProfile`、
`terminalFontFamily`、`integratedTerminalShell`、`httpProxy`、`httpProxyNoProxy`、`httpProxyCaCertPath`、
`embeddedBrowserAllowInsecureCertificates`、`embeddedBrowserViewportPreference`、
`computerUseComposerEntryHidden`、`taskAutoArchiveEnabled`、`taskAutoArchiveOlderThanDays`、
`closeToTrayOnWindows`、`keepAwakeWhileRunning`、`desktopZoomLevel`、`desktopWindowSize`、
`desktopChromiumHardwareAccelerationEnabled`、`messageStreamShowReasoning`、`messageStreamShowTodos`、
`toolGroupingExploreEnabled`、`toolGroupingTerminalEnabled`、`toolGroupingChangesEnabled`、
`zcodeInteractionBehavior`、`askUserQuestionAutoResolutionEnabled`、`modelIoFullRetentionEnabled`、
`nativeSearchEnhancementsEnabled`、`proactiveSuggestionsEnabled`、`memoryEnabled`、
`receivePreviewUpdates`、`autoDownloadAndInstallUpdates`、`zcodeEndpointOrigin`、
`startPlanRecommendationDismissed`、`onboardingOccupation`。

实现要点：**只搬源文件里显式出现过的键**（源里没写 = 用户没设过，不要用 schema 默认值覆盖目标），
且逐个键过 `appSettingsPatchSchema` 的字段校验，坏键丢弃并计入 `details`。

- **共享域不迁移，且在界面上如实说明**：skills / commands / plugins / AGENTS.md 两个身份都写死
  `~/.zcode/...`（身份归属总表的"用户资产共享域"），物理上就是同一份目录，没有可搬的东西。
  因此界面上不出现这几个勾选项，只在"不迁移的内容"折叠说明里讲清原因——否则用户会以为功能漏做。

- **不可迁移域一律不提供**（界面折叠说明，不是灰掉的勾选项，避免暗示"以后会有"）：
  hook 信任记录（`security/workspace-hook-trust-v1.json`，权限边界，fail-closed，必须在目标身份
  重新审核授权）、`computer-use` / `server` / `agents` 制品（跨机可达域，重新安装或下载即可）、
  日志 / 轨迹 / 崩溃 dump / mailbox（诊断与临时数据，搬过去只放大噪声）。

- **来源根复用已有的多根探测，不写死官方**：官方根候选链与"home 下 `.zcode-<身份>` 扫描"已经
  在用量账本里实现过（`packages/services/src/usage-ledger/ledgerRoots.ts`）。把它收成单源模块
  `packages/services/src/data-roots/machineDataRoots.ts`，账本改为 re-export 同名导出，
  账本调用点零改动。副作用：反向迁移天然可用（自建版里也能看到官方根并搬过去），零额外代码。

- **凭据走加解密链路，不整文件覆盖**：`credentialCipherProvider.ts`（Host 侧）与
  `packages/adapters/src/auth/credential-cipher.ts`（CLI 侧）用**同一个机器派生密钥**
  （`ZCODE_CREDENTIAL_SECRET` 环境变量，缺省 `zcode-credential-fallback:{platform}:{homedir}:{username}`），
  **不含产品身份**。所以同机上源文件可以被目标身份解出明文。流程是：读源 `credentials.json` →
  解密 → `ICredentialService.save(key, plaintext)`，由目标侧重新加密落盘。这样既不双重加密，
  也不把密文当作"原样可搬的字节"。

- **不依赖进度回调**：RPC（`packages/rpc`）不序列化函数参数，`ISettingsSyncService.importSelected`
  的 `onProgress` 就是被实现忽略的死参数。所以服务面不做进度事件，改成 UI 侧**逐域串行调用**
  `migrateDomain`，"第 k/n 步"进度天然成立，且单域失败不阻塞后续域（用 `status: "failed"` 回报）。

- **不做逐会话挑选**：要从外部库读会话再重建任务记录，复杂度等同 `importClaudeSessions`，
  本期只做整库"补缺失"。选中 `sessions` 即整库搬运，不做会话级勾选。

- **WSL / 远端数据根不纳入**：跨文件系统拷贝的语义（权限位、换行、锁、大小写敏感）与本地不同，
  且 `{dataRoot}` 在远端是另一台机器的路径。理由写在探测模块注释里，本期不承诺。

## 行为

| 环节       | 位置                                                | 行为                                                                                       |
| ---------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 来源根探测 | `services/src/data-roots/machineDataRoots.ts`       | 列出本机所有数据根，标注 `variant` / `identity`；排除当前身份；官方根排首位                |
| 域扫描     | `services/src/migration/migration.ts` → `domains/*` | 逐域算 `available` / `itemCount` / `bytes` / `conflictCount` / `defaultSelected`           |
| 单域迁移   | `migrateDomain({ sourceRootPath, domain })`         | 独立事务语义：某域失败不影响其它域，返回该域 `imported` / `skipped` / `failed` / `details` |
| 设置迁移   | `domains/appSettings.ts`                            | 读源 → `appSettingsSchema` → 剔除 `dataBaseDir` → `settingService.update(patch)`           |
| 凭据迁移   | `domains/credentials.ts`                            | 读源文件（不覆盖目标）→ 逐 key 解密 → `credentialService.save`                             |
| 会话迁移   | `domains/sessions.ts`                               | SQLite `VACUUM INTO` 临时文件 → `rename` 落位；失败回滚本次新建产物                        |
| 工作流迁移 | `domains/workflows.ts`                              | 逐文件 `copyFile`，同名（含扩展名归一后重名）跳过                                          |
| hooks 迁移 | `domains/hookDeclarations.ts`                       | 按事件 + matcher 键合并进目标 `cli/config.json`，同名跳过，保留目标其它字段                |
| 服务注册   | `services/src/node.ts`、`services/src/accessor.ts`  | 注入 `settingService` / `credentialService` / 密文 provider / `homeDir`                    |

## 所有权与不变式

- **唯一写侧**：所有域写入都通过目标身份已注册的服务（`settingService` / `credentialService`）
  或目标身份数据根内的路径，不新增第二条写入通路；RPC channel 只暴露 `discoverSources` /
  `scanSource` / `migrateDomain` 三个读-写入口。
- **目标已有数据永不被覆盖**：`sessions` / `providerConfig` 整域跳过，其余逐项跳过。冲突计数
  `conflictCount > 0` 时 UI 明示"n 项已存在"。
- **来源身份不可见性**：探测结果排除当前身份的根，避免"自己迁自己"；`sourceRootPath` 由调用方
  传入的字符串必须落在探测结果集合内，否则拒绝。
- **路径安全**：所有源文件名过白名单归一，`workflows` 只取目标目录的直接子文件（不递归），
  拒绝路径穿越；`sessions` 只搬列出的三类产物路径。
- **只对本机生效**：迁移搬的是「运行该服务进程的那台机器」上的其它身份数据根。UI 因此固定用
  **本地 Host** 的 services 渲染（照 `modelProvider` / `memory` 两个设置节的先例
  `<ServiceProvider services={localHostServices}>`），远端 workspace 激活时不注入远端 Host——
  否则面板会列出远端机器的数据根，与「从官方版 ZCode 迁移本机数据」的语义不符。
- **不变式**：官方身份（空后缀）数据根本身在迁移中只作目标或来源之一，其路径规则不变；
  迁移成功后目标身份能读到迁移的数据（凭据可 `load` 出明文、设置生效、工作流可列出）。

## 失败语义

- **单域失败不影响其它域**：`migrateDomain` 捕获异常后返回 `status: "failed"` 与 `error` 摘要，
  调用方继续下一个域；`details` 每条上限 50 条，避免 RPC payload 爆炸。
- **扫描失败**：`scanSource` 抛错时 UI 显示失败原因 + 重试；`available: false` 的域带
  `skipReason`（如"来源没有这项数据"），不是错误。
- **源文件损坏**：该域 `failed`，目标**保持不变**（`appSettings` 在 zod 校验通过前不写、
  `credentials` 单 key 解密失败只跳过该 key、SQLite 快照失败不落位）。
- **设置写入被账号校验拒绝**：`settingService.update` 的 `expectedAccountSettings` 仅在其传入时
  生效；迁移不传该参数（迁移不涉及账号连接切换），拒绝语义与普通设置更新一致。
- **部分成功如实上报**：`imported` / `skipped` / `failed` 三个计数都返回，不用"成功"概括。

## 迁移边界

- 迁移后的数据不再与源身份联动：源身份后续新增的会话 / 工作流不会自动同步；重复执行迁移只会
  把新出现的条目补进来（已存在的照旧跳过）。
- `hookDeclarations` 只搬**声明**，不搬信任记录：目标身份首次触发这些 hook 时仍需按 fail-closed
  流程重新授权。
- 迁移不搬运运行中的进程状态（`runtime/`、`bots-runtime-locks/`、`*-shm` / `*-wal` 由 SQLite
  快照本身保证一致性）。
- 迁移不可逆：目标已有的跳过、新写入的没有"撤销"入口。需要回退时删除目标文件后重来。

## 验证

- `packages/services/test/dataMigration.test.ts`（临时 home 造两个身份根）：
  1. 来源探测排除自身、官方根优先；
  2. 每域 `available` / `itemCount` / `conflictCount` 与真实文件一致；
  3. 设置迁移后偏好字段到位且目标 `dataBaseDir` 未被改动；
  4. **凭据迁移后 `credentialService.load(key)` 能取回明文**（验证走的是加解密链路而非整文件复制）；
  5. 工作流同名跳过、异名导入（`.dwf.ts` 与 `.workflow.js` 各一）；
  6. hooks 合并后目标 `cli/config.json` 其它字段不变；
  7. `providerConfig` / `sessions` 目标已存在 → 整域跳过，目标字节不变；
  8. 源文件损坏 → 该域 `failed` 且目标不变。
- 手工验收路径：设置 → 数据与统计 → 数据迁移 → 选来源根 → 勾域 → 开始迁移 → 逐域状态与结果汇总；
  引导欢迎页的次级按钮能直接跳到该节。
