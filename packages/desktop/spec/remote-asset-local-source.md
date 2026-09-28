# 自建 / 离线：远端资产改用本机目录（spec）

## 背景与问题

打包态 `resolveRemoteAssetDirs` 只返回 CDN + 本地缓存，**没有任何本地资产入口**。
于是自建 / 离线场景（无公网 CDN、仅本机使用）连远端（WSL / SSH / Docker）时，
只能从官方 CDN 取到**官方** server bundle，导致能力错配——例如自建版新增的
`requestPolicy` 被官方远端 Server 的严格校验拒绝，表现为
`Provider Provisioning 首次同步失败 (failed)`。

开发态已有仓库内 `mock-cdn` 可用，但打包态拿不到这条路。

## 设计决策

- 新增环境变量 `ZCODE_REMOTE_ASSET_LOCAL_DIR`，指向一个与 `mock-cdn` 同构的
  本地资产根（其下含 `releases/<version>/`）。
- 该变量**在打包态与开发态都生效**：显式替代 CDN 作为远端资产来源，复用既有的
  “本地读取 + 上传部署”路径（`ConnectOptions.mockCdnDir`）。
- 官方渠道不设置该变量，行为完全不变。

## 行为

- 设置了 `ZCODE_REMOTE_ASSET_LOCAL_DIR` → `resolveRemoteAssetDirs` 返回
  `mockCdnDir = <该目录>`（打包 / 开发皆然），远端部署走本地上传，不访问 CDN。
- 未设置 → 保持现状：
  - 开发态：仓库 `mock-cdn`（若存在的 `releases/<version>`）；
  - 打包态：CDN + 本地缓存。

## 所有权与不变式

- **单一来源**：远端资产来源仍由 `resolveRemoteAssetDirs`（desktop main 进程）
  单点决定，Host 与连接层只消费快照，不各自解析。
- **不变式**：变量未设置时，各渠道（官方打包 / 开发）行为与改动前逐字节一致。

## 失败语义

- 目录缺少 `releases/<version>` 时**不静默回退到 CDN**，交由既有 mock-cdn
  完整性诊断告警（例如 `mock-cdn incomplete for <platform>`），避免
  “以为用了本地、实际走了公网”的隐性错配。

## 迁移边界

- 纯增量，无数据迁移。
- 自建打包版由外部启动器（`E:\ZCode-dev`）在启动时注入该变量，指向其
  `mock-cdn`（或固定资产目录）；资产由 `pnpm prepare:remote-assets` 生成。
- 远端代码安装根的产品隔离见 `packages/server/spec/remote-runtime-isolation.md`；
  本 spec 只负责“资产从哪来”，二者配合实现自包含的自建远端。
