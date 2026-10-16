# 设置页「数据存储路径」显示当前数据根（spec）

涉及包：`packages/ui`（设置页展示与文案）、`packages/shared`（`SystemInfo` 协议字段、测试 id）、
`packages/services`（`systemService.info()` 产出 `dataRootDir`）。`packages/desktop` 复用同一
`ISystemService` 注册，无代码改动。

## 背景与问题

设置页「数据存储路径」输入框展示的是**父目录**（`AppSettings.dataBaseDir`，空则回退家目录），
而真实数据根 = `{父目录}/.zcode{suffix}`，其中后缀由产品身份决定（官方渠道空串 `.zcode`，
自建版 `.zcode-rayn`）。设置项说明文案写死「路径后缀 .zcode/v2 不可更改」，在自建版上与实际
不符（实际后缀是 `-rayn`），且用户从这一屏看不到自己真实的数据根路径，容易以为数据在
`.zcode` 下、找文件/手动备份时对不上。

## 设计决策

1. **「当前数据根」由 `systemService.info()` 统一提供**：`SystemInfo` 新增 `dataRootDir` 字段，
   值为 `getZCodeDataRootDir()`（services `paths.ts` 既有单源：`setDataRootDir()` >
   `ZCODE_DATA_ROOT` > `{dataBaseDir}/.zcode{suffix}`，后缀拼法委托
   `@zcode/shared/identity-paths-node`，不在此处重复拼）。设置页不再自行推导后缀。
2. **设置页在输入框下方新增一行展示**：`当前数据根：{dataRootDir}`。父目录（可改）与完整根
   （只读、含身份后缀）并排呈现，用户一眼看到真实位置，消除「界面说 .zcode、数据却在
   .zcode-rayn」的认知错位。
3. **说明文案去掉写死的 `.zcode/v2`**：改为中性的「数据根目录名由应用身份决定，不可更改」，
   具体后缀由新增展示行动态呈现，不再在静态文案里固化任何渠道的路径。
4. **不改数据根解析与迁移逻辑**：`dataBaseDir` 的读写、`copyDataDirectory` 迁移、bootstrap
   指针文件（`setting.json`）均不动；本次只加一个只读展示字段。
5. **远端链路自动生效**：远端 server 注册的是同一 `ISystemService`（`packages/server/src/http.ts`），
   client 经 `ProxyChannel.toService<ISystemService>` 代理，字段随协议对象整体透传，无第二套实现。

## 行为

| 环节          | 位置                                            | 行为                                                                                           |
| ------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 数据根来源    | `services/src/system/systemService.ts` `info()` | 返回 `{ homedir, platform, dataRootDir: getZCodeDataRootDir() }`                               |
| 设置页取值    | `ui/src/SettingsPage.tsx`                       | `systemService.info()` 回调里 `setEffectiveDataRootDir(info.dataRootDir)`                      |
| 展示          | `ui/src/settings/DataBaseDirControl.tsx`        | 按钮行下方渲染 `当前数据根：{dataRootDir}`，testid `TID_SETTINGS_DATA_BASE_DIR_EFFECTIVE_ROOT` |
| 文案（zh-CN） | `i18n/locales/zh-CN.ts`                         | description 去 `.zcode/v2` 写死；新增 `settings.dataBaseDirEffectiveRoot`                      |
| 文案（en-US） | `i18n/locales/en-US.ts`                         | 同上                                                                                           |

## 所有权与不变式

- **唯一事实源是 `getZCodeDataRootDir()`**（services `paths.ts`）。UI 只读不写：新增字段不影响
  `dataBaseDir` 的保存/迁移/重启生效语义。
- **`SystemInfo` 字段由 `ISystemService` 全链路透传**：desktop host、远端 http 注册、client
  proxy 共用同一接口类型，加字段不需要任何包单独接线。
- **文案不再承载渠道事实**：任何「路径后缀是什么」的展示只来自运行时的 `dataRootDir`，
  静态 i18n 不固化 `.zcode` 或 `.zcode-rayn`。

## 失败语义

- `systemService.info()` 本身失败（极罕见）：沿用现有 `.catch(() => {})`，`dataRootDir`
  保持初始空串，展示行不渲染——设置页其余功能不受影响。
- `getZCodeDataRootDir()` 恒返回非空路径（`homedir()` 兜底），不存在空值展示。

## 迁移边界

- 协议变化仅「`SystemInfo` 增加必填 `dataRootDir: string`」；所有实现方（services 一处）
  同步返回，无兼容分支。
- 不新增服务方法、不改 `AppSettings` schema、不动 `setting.json` 指针文件。
- 「资源管理器 → 存储」tab 既有根路径展示（`StorageRootUsage.path`）保持不变，两处路径同源
  （都来自数据根解析），不引入第二份数据。

## 对应测试

- `packages/services/test/systemService.test.ts`：`info()` 返回的 `dataRootDir` 为非空字符串。
- `packages/ui/test/settingsDataBaseDirControl.test.ts`：`GeneralSectionContent` 传入
  `dataRootDir` 后渲染出 `当前数据根：{dataRootDir}`；既有 `dataBaseDir` 只读/保存/复制用例不变。
