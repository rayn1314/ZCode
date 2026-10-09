# API Key 预设与切换（apiKeyPresets）

涉及包：`packages/provider`（数据层，主责）、`packages/ui`（切换与管理界面）。

## 背景与问题

同一个供应商（同 baseUrl、同协议）往往有多个可用 API Key，用户目前只能手动把 Key 粘进
`ApiKeyInput` 来回改。需要一套「预存若干 Key + 一个备注名 + 一键切换」的最简机制。

## 设计决策

1. **数据挂在 provider 的 `access` 上**：`apiKeyAccessDataSchema` 新增可选字段
   `apiKeyPresets: Array<{ id, name, apiKey }>`，与生效 Key 同文件同层
   （`{dataRoot}/v2/provider_config.json`，0600）。现状 API Key 本就明文落盘，预设不另起
   加密体系，安全级别与既有 Key 一致。
2. **切换 = 把选中预设的 `apiKey` 写进现有 `access.apiKey`**，完全复用既有草稿保存链
   （idle flush / blur flush / `savePersonalProviderOverlay`）。不新增协议命令、不新增服务
   方法、不引入独立的「activePresetId」指针——当前生效预设由「`apiKey` 与预设列表按值比对」
   得出，无匹配即「自定义 Key」，手改 Key 后自然脱选。
3. **模板层禁带预设**：`rule-data-schema.ts` 的模板 access 从 `apiKeyAccessDataSchema` omit
   掉 `apiKey` 的同时 omit `apiKeyPresets`——理由与「模板不得携带 Key」相同：模板是可分发的
   元数据，不含任何密钥材料。
4. **预设不下发执行面**：`resolver.serializeRegistryProviderConfig` 只序列化生效
   `apiKey`/`apiKeyManagementUrl`，预设列表不进入 Registry，Agent 进程不可见。
5. **overlay 语义**：`ApiKeyAccessConfig.overlay` 对 `apiKeyPresets` 走基类「undefined=继承、
   有值=整组替换」——增删改预设就是整组替换；模板层永远没有该字段，个人层不写即保留原值。

## 行为

- 仅 `isApiKeyAccess`（`api-key` / `zhipu-coding-plan-api-key`）型 provider 暴露预设功能；
  `zhipu-account` 账号型不适用。
- UI 在 `ApiKeyInput` 下方提供「Key 预设」行：下拉展示预设（备注名 + 掩码 Key），选中即写入
  生效 Key 并立即保存；齿轮入口打开管理弹窗（列表、新建「名称 + Key」、编辑、删除）。
- 预设列表从 effective `provider.config.access.apiKeyPresets` 读取（表单展示 effective 的既有
  惯例）；写入时 effective 与 personal 两侧补丁同源，方式与 `apiKey` 一致。

## 所有权与不变式

- 预设的唯一所有者是 personal 层 provider 配置（`NodePersonalProviderConfigRepository` 事务写）。
- `apiKey`（生效 Key）与 `apiKeyPresets`（预存池）是两个独立叶子：改其中一个不隐式改另一个；
  但「手动改 Key」的草稿补丁必须 spread 携带 `apiKeyPresets`，不得将其清空（有测试钉死）。
- 预设项 `name`、`apiKey` 非空；`id` 由 UI 生成（`crypto.randomUUID`），用于稳定编辑/删除目标。

## 失败语义

- 保存时 `savePersonalProviderOverlay` → `parseProviderConfig`（strict zod）校验预设结构，
  非法（空名、空 Key、多余字段）→ 保存被拒、报错、不落盘，既有数据不变。
- 切换本身没有独立失败路径：它就是一次 Key 保存，失败表现与手改 Key 一致。

## 迁移边界

- 字段为 optional/nullable，旧 `provider_config.json`（`schemaVersion=1`）天然兼容，codec 不动、
  不升版本；只有写入预设后文件里才出现该字段。
- 跨环境 provisioning 按既有 provider 配置整体搬运语义随行，无需改凭据白名单。
