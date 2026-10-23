# api-key-preset

## 意图

同一个供应商（同 baseUrl、同协议）常年有多个可用 API Key，用户不该反复手工粘贴替换。
本模块提供「预存若干 Key + 一个备注名 + 一键切换」的最简机制：`ApiKeyInput` 下方的切换行
（`ApiKeyPresetSwitcher`）+ 管理弹窗（`ApiKeyPresetManagerDialog`，二级形态：列表 / 新建 / 编辑 / 删除）。

数据模型、overlay 语义与跨环境边界见 `packages/provider/spec/api-key-presets.md`；本模块只是它的 UI 面。

## 不变量

- **切换 = 写生效 Key**：选中预设就是把 `preset.apiKey` 写进现有 `access.apiKey`，复用既有草稿保存链；
  不新增协议命令、不新增服务方法。
- **没有 activePresetId 指针**：当前生效预设由「`apiKey` 与预设列表按值比对」得出（`findActiveApiKeyPreset`）；
  手改 Key 后自然脱选（显示「自定义 Key」），因此不存在指针与真实 Key 走散的问题。
- **`apiKey` 与 `apiKeyPresets` 是两个独立叶子**：改其中一个不隐式改另一个；手动改 Key 的草稿补丁
  必须携带 `apiKeyPresets`，不得清空（provider 侧有测试钉死）。
- **增删改是整组替换**：`apiKeyPresets` 在 overlay 上是「有值=整组替换」，所以每次修改都把完整数组
  交回调用方保存；`id` 由 UI 的 `crypto.randomUUID()` 生成，是编辑/删除的稳定目标。
- **只露尾 4 位**：菜单与列表一律用 `maskApiKey`；完整 Key 只在编辑表单里可见（按需显隐）。
- **值域**：`name`/`apiKey` 非空（新建时 `trim`）；只有 `isApiKeyAccess` 型 provider
  （`api-key` / `zhipu-coding-plan-api-key`）暴露本功能，`zhipu-account` 账号型不适用。

## 与其它模块的交集（hook 点）

- **保存链**：`onApply` / `onSavePresets` 由 provider 表单实现，最终落到
  `savePersonalProviderOverlay`（strict zod 校验：空名、空 Key、多余字段直接拒绝，既有数据不变）；
  保存失败的表现与手改 Key 完全一致，本模块不另建失败语义。
- **读取**：预设列表从 effective `provider.config.access.apiKeyPresets` 读取（表单展示 effective 的惯例）；
  写入时 effective 与 personal 两侧补丁同源，方式与 `apiKey` 一致。
- **模板层与执行面**：provider 模板 access 在 omit `apiKey` 的同时 omit `apiKeyPresets`，
  `serializeRegistryProviderConfig` 也不下发预设——Agent 进程看不到预设列表；
  本模块不参与这两处，改动它们时不需要动 UI。
