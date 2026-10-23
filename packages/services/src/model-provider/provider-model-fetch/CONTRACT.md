# provider-model-fetch

## 意图

「服务商卡片 → 拉取模型」的端口：拿设置表单当前值去供应商端点拉可用模型，交给设置页勾选后加入配置。
端点探测借鉴 CCSwitch 的 `fetch_models_for_config`，分组展示借鉴 new-api 的 `resolveModelProvider`；实现见
`packages/services/src/model-provider/providerModelFetch.ts`。

## 不变量

- 网络请求只发生在服务端：`fetch` 由装配层注入 Host 的 HTTP transport（代理 / CA 生效），渲染进程不
  直接访问供应商端点；请求参数取**表单当前值**，不是已保存配置。
- 候选端点顺序固定、去重保序，逐候选降级：404 / 405 换下一个，401 / 403 立即 `auth` 失败（换 URL 不会
  变好），全部候选都 404 归 `not-found`。
- 结果按模型 ID 排序去重，重复条目保留首次出现的 `ownedBy`；`data[].id` 与 `models[].slug` 两种形状都收。
- 凭据不出现在错误消息里：API Key 一律替换为 `[REDACTED]`，404 响应体截断到 512 字符。
- 端口无状态、可重试：每次调用独立 AbortController 与超时（默认 15s），超时归类 `timeout`。
- UI 侧：已在本供应商配置里的模型不可再选；`onAddModels` 缺席即只读浏览（按钮禁用）。

## 与其它模块的交集（hook 点）

- `packages/services/src/node.ts`：端口在此用 Host transport 造出（`fetchProviderModels`），并经
  `@zcode/services` 公开出口暴露——这是渲染进程拿到该能力的唯一路径。
- `packages/ui/src/settings/model-provider-section/ProviderCardSections.tsx`：弹窗的渲染方，负责把表单
  当前值与已配置模型 ID 传进来；分组（`providerModelFetchCategories.ts`）与弹窗状态（搜索 / 折叠 /
  「新模型 / 已有模型」两个 Tab）都在 UI 侧，不进端口契约。
- `packages/provider`：只借 `ProviderApiType` 决定鉴权头（`anthropic-messages` 用 `x-api-key`，其余用
  Bearer），不读 provider 配置仓储——配置不由本模块写回。

运行时回归位于 `contract.test.ts`（契约语义）与 `packages/services/test/provider-model-fetch.test.ts`（全量解析与错误分类）。
