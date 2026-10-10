# 拉取模型列表（Provider Model Fetch）

> 涉及包：`packages/services`（服务端拉取能力与装配）、`packages/ui`（设置页按钮与批量添加）、`packages/provider`（`IProviderSettingsService` 接口面）。主责包为 `packages/services`。

## 背景与问题

模型供应商卡片目前只能逐条手动填写模型 ID 并补全元数据。对于硅基流动、OpenRouter、DeepSeek 等提供大量模型的供应商，用户无法快速把可用模型批量加入配置，体验与 CCSwitch 等工具差距明显。

参考开源项目 [CCSwitch](https://github.com/farion1231/cc-switch) 的 `fetch_models_for_config` 与 `FetchedModelPicker`：在供应商表单内提供「拉取模型」入口，调用 OpenAI 兼容的 `GET /v1/models` 端点（含 Anthropic 兼容子路径剥离与 `/models` 版本段兜底），返回可搜索、可多选的模型列表，勾选后批量添加。

## 设计决策

1. **拉取发生在服务端（node side），不在渲染进程直接 fetch。** 复用 `hostApiNetworkTransport.fetch`（undici + 代理/CA 设置），避免浏览器 CORS 与 Electron 渲染进程网络策略差异，并与 `testModelConnectivity` 的服务化路径保持一致。
2. **接口挂在现有 `IProviderSettingsService` 上**，新增 `fetchProviderModels(input)`。方法签名对 UI 透明，RPC 通过 `ProxyChannel.fromService` 自动暴露。
3. **请求参数取表单当前值**（baseUrl / apiKey / apiFormat），而不是读取已保存配置：用户可能刚修改端点尚未触发保存，拉取应针对用户正在编辑的目标。
4. **端点候选与响应解析借鉴 CCSwitch**：
   - 候选 URL：`{base}/v1/models`；baseUrl 已以 `/v{N}` 版本段结尾时用 `{base}/models`；命中已知 Anthropic 兼容子路径后缀时剥离后再拼 `/v1/models`、`/models` 兜底。
   - 鉴权头按 `apiFormat`：`anthropic-messages` → `x-api-key`；`openai-chat-completions` / `openai-responses` → `Authorization: Bearer`。
   - 响应兼容 OpenAI `{data:[{id, owned_by}]}`、Anthropic `{data:[{id}]}`、智谱 `{models:[{slug}]}` 三种形状；`models` 收成任意 JSON 值，避免供应商附带异常形状导致整体解析失败。
   - 结果按模型 ID 排序并去重。
5. **批量添加走现有 `addPersonalModel`**，每个选中模型以 `useRecommendedConfig=true`、空个人覆盖配置添加：内置规则命中的模型自动获得完整推荐元数据，未命中的模型以「待补全」状态进入列表（沿用既有 `modelConfigIncomplete` 提示），用户可后续编辑。
6. **已配置模型在弹窗中禁用并标记**，避免重复添加（`addPersonalModel` 本身也会拒绝重复）。

## 行为

### 入口

- 模型供应商卡片 → 模型列表标题行，「+ 添加模型」按钮左侧新增「拉取模型」按钮（次要样式，下载图标 + 文案）。
- 仅当供应商为 API Key 类型（`isApiKeyAccess(providerAccess)`）时显示；账号型供应商（如 `zhipu-account`）没有可用的端点鉴权，不显示。
- 未填写 Base URL 或 API Key 时按钮保持可用，点击后在弹窗内给出本地化错误提示（缺 Base URL / 缺 API Key），不发起请求。

### 拉取弹窗

1. 点击「拉取模型」打开弹窗，立即发起拉取；加载中显示 spinner 与「拉取中…」文案。
2. 成功：弹窗内展示「新模型 / 已有模型」两个 Tab（借鉴 new-api 的 `UpstreamModelSelection`）：
   - **新模型**：拉取结果中尚未配置的模型，可勾选添加；按供应商分组展示为折叠卡片，组头带组级全选 Checkbox（部分选中时显示半选态）、组名与数量、`已选/总数`、折叠箭头，组内模型多列网格排列。
   - **已有模型**：已配置的模型，复选框禁用并标记「已添加」，不可重复添加。
   - 分组名优先取 `/v1/models` 返回的 `ownedBy`；缺失时按模型 ID 前缀推断常见供应商（`claude-` → Anthropic、`gpt-`/`o1-` 等 → OpenAI、`glm-` → 智谱等）；都无法归类时归入「其他」，并排到分组末尾。
   - 顶部搜索框按模型 ID 与分组名不区分大小写过滤，搜索时自动展开所有匹配分组。
3. 失败：弹窗内显示分类错误文案与「重试」按钮，错误分类：
   - 缺 Base URL / 缺 API Key（前端预检）
   - 鉴权失败（HTTP 401/403）
   - 端点不存在（404/405，或所有候选端点均失败）
   - 超时
   - 响应解析失败（端点不支持）
   - 其他网络/HTTP 错误
4. 底部显示「已选 N 个模型」；点击「添加选中 (N)」后逐个调用 `addPersonalModel`（已配置的跳过），全部完成后关闭弹窗，列表出现新模型；添加过程按钮进入 saving 状态，任一失败则展示错误并保留弹窗。

### 数据流

```
ProviderCardSections.tsx
  ├─ 点击拉取 → providerSettingsService.fetchProviderModels({providerId, baseUrl, apiKey, apiFormat})
  │                ├─ providerModelFetch.ts：构造候选 URL + headers → 请求 → 解析 → 排序去重
  │                └─ 错误映射为 ProviderModelFetchError(code)
  ├─ 弹窗勾选 → 对每个选中模型 providerSettingsService.addPersonalModel(providerId, modelId, {}, true)
  └─ 提交最后一次返回的 ProviderSettingsView 到 useProviderSettingsServiceView
```

## 所有权与不变式

- 模型列表拉取能力的唯一所有者为 `IProviderSettingsService.fetchProviderModels`；UI 不直接发起对供应商端点的网络请求。
- 拉取是只读操作，不写配置、不触发 Registry 变更。
- 批量添加复用 `addPersonalModel` 的既有不变式：重复模型拒绝、内置模型不受影响、模型顺序按既有 `normalizeModelOrder` 规则追加。
- 端点候选构造与响应解析逻辑集中在 `packages/services/src/model-provider/providerModelFetch.ts`，不扩散到 UI 或 provider 包。

## 失败语义

- 拉取失败不修改任何配置；弹窗保留用户已勾选状态，可重试。
- 批量添加为逐模型事务：已成功的保持成功，失败的在弹窗内报告，不整体回滚。
- 网络请求带 15s 超时，超时归类为 `timeout`。
- 所有错误消息在服务端脱敏（不包含 API Key），UI 只展示分类文案与通用错误信息。

## 迁移边界

- 新增方法对旧 Host / 远端旧版本服务端不可用时，`fetchProviderModels` 会按 RPC 既有语义报错；UI 侧将该错误归类为「拉取失败」展示。
- 不改变既有「添加模型」弹窗与手动添加流程。
- 不改变 `addPersonalModel` 的签名与语义。
