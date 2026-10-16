# Web 远程控制自建 Relay 服务端

涉及包：`packages/server`（本文落点，新增 relay entry）、`packages/shared`（协议类型与鉴权向量，只读复用）、
`packages/desktop`（device 侧客户端，只读复用）、`packages/web`（terminal 侧客户端与 PWA，只读复用）。
跨包变更只在本文件落一份 spec，不在多处复制。

## 背景与问题

上游 v3.15.1 合入后，Web 远程控制在仓库内**已经完整实现**：

- 桌面侧：`packages/desktop/src/main/webRemoteControlManager.ts` + `webRemoteControlTransport.ts`
  （device 角色连出、注册、鉴权、配对状态机、心跳、重连、attachment 调度与 acknowledged RPC 桥接）。
- 手机侧：`packages/web/src/webRemoteControlTransport.ts`（terminal 角色）+ `packages/ui/src/WebRemoteControlMobileShell.tsx`
  等移动 shell。
- 共享协议：`packages/shared/src/web-remote-control.ts`。
- 产品文档：`docs/web-remote-control/web-remote-control-architecture.md`。

**唯一不在本仓库的是 relay 服务端**（官方称 `zcode-remote-hub`），默认地址
`wss://zcode.z.ai/ws`（`packages/shared/src/zcodeEndpoint.ts:14`）。

自建/自用版本无法使用官方 relay：桌面与手机都是自建产物，官方 relay 上没有对应设备与账号绑定。
因此需要**自托管一个协议等价的 relay**。

关键有利条件：relay **不解析业务 payload**，只透传 `data.payload`（架构文档「Transport」节明确
"ZCode 业务消息全部放在 relay `data.payload`，relay 不解析 payload"）。所以自建 relay 与自建
桌面/手机的业务版本**解耦**，只需实现 transport 协议，不需要跟随 ZCode 业务 schema 演进。

## 设计决策

1. **relay 落在 `packages/server` 新增 entry**，不新增 workspace 包。
   理由：relay 与现有 HTTP server 同为"网络表面"，复用 `ws`、`hono`、`@zcode/shared` 依赖，
   避免为 ~500 行代码引入新包、workspace 注册与架构基线漂移。
2. **relay 是盲转发 broker**：不解析 `data.payload`、不持有 task/session/stream/queue/snapshot 业务状态。
3. **配对身份**：`device_sid` + `pass_hash`。
   `pass_hash = base64(sha256(password))`，`password` 只出现在二维码 URL 与桌面 credentialService。
   `proof = base64url(HMAC-SHA256(key=pass_hash, msg="${nonce}|${role}|${device_sid}"))`。
   实现必须与 `packages/desktop/src/main/webRemoteControlRelayAuthProvider.ts` 逐位一致，
   并满足 `WEB_REMOTE_CONTROL_RELAY_AUTH_PROOF_VECTORS`（`packages/shared/src/web-remote-control.ts:202`）。
4. **一个 device 同时只配一个 terminal**。新 terminal 接入时向旧 terminal 下发 `error: KICKED`
   并断开旧连接（桌面对 KICKED 的处理是重连，不会关闭桌面侧 runtime）。
5. **内存态即可**。relay 重启后 device 会因 `AUTH_FAILED` 走桌面既有的
   `onInvalidPersistedAuth` 重新注册路径（`webRemoteControlTransport.ts:493-509`），因此不需要
   跨重启持久化即可自愈；提供可选的文件持久化作为增强。
6. **桌面零入站端口**：桌面只主动连出 relay。relay 可部署在局域网机器（零公网暴露）或 VPS。
7. **PWA 托管由 relay 顺带提供**：`ZCODE_WEB_STATIC_ROOT` 指向 `packages/web/dist`，
   或交给 nginx；桌面通过 `ZCODE_WEB_REMOTE_CONTROL_URL` 把二维码指向该地址。

## 行为

### 连接与角色

- 客户端连接 `${relayWsUrl}`，即 `ws[s]://<host>[:port]/ws`。
- 连接必须带 routing hint：query `?mid=<device_mid>` 与/或 header `X-Device-ID: <device_mid>`。
  relay 只用它做同 device 的槽位对齐，**不作为鉴权依据**。
- 角色由首条 `auth_init.role` 区分：`device`（桌面）与 `terminal`（手机）。

### device 角色

| 步骤 | 客户端发送                                            | relay 响应                                                |
| ---- | ----------------------------------------------------- | --------------------------------------------------------- |
| 1    | `device_register_init {device_mid, pass_hash, meta}`  | `device_register_ack {device_sid}`（分配 `dvc_<random>`） |
| 2    | `auth_init {role:"device", device_sid, meta}`         | `auth_challenge {nonce}`                                  |
| 3    | `auth_response {device_sid, proof}`                   | `auth_ack {device_sid, pair_status}`                      |
| 4    | `pair_status_query {device_sid}`（8~12s jitter 心跳） | `pair_status_ack {pair_status, terminal_sid?}`            |

- `pair_status` 为 `waiting`（无 terminal）或 `matched`（已有 terminal）。
- 注册即把 `device_sid → {device_mid, pass_hash, socket}` 写入内存注册表；同一 `device_mid`
  重复注册时作废旧 `device_sid` 并断开旧 socket。
- `auth_init` 携带的 `device_sid` 若不在注册表中：若首条消息就是 `auth_init`（桌面重启后
  用持久化 sid 重连）返回 `error: AUTH_FAILED`，桌面据此重新注册。
- `pass_hash` 只用于校验 `auth_response`，不写入日志。

### terminal 角色

| 步骤 | 客户端发送                                      | relay 响应                                     |
| ---- | ----------------------------------------------- | ---------------------------------------------- |
| 1    | `auth_init {role:"terminal", device_sid, meta}` | `auth_challenge {nonce}`                       |
| 2    | `auth_response {device_sid, proof}`             | `auth_ack {device_sid, pair_status}`           |
| 3    | `pair_status_query {device_sid}`                | `pair_status_ack {pair_status, terminal_sid?}` |

- terminal 的 `device_sid` 与 `pass_hash` 来自二维码 URL（`sid` 与 `hash` 参数）。
- `device_sid` 不存在 → `error: DEVICE_OFFLINE`。
- proof 不匹配 → `error: AUTH_FAILED`。
- 认证通过后：若该 device 当前无 terminal → 配对成功，`pair_status: "matched"`；
  若已有 terminal → 向旧 terminal 下发 `error: KICKED` 后断开，再把新 terminal 配上。
- device 当前离线（无已认证 device socket）→ `pair_status: "waiting"`，terminal 保持连接等待。

### 数据面

- 双向 `data {payload, client_ts, server_ts}`：relay 原样转发给配对另一端。
- **payload 必须 opaque**：relay 不得 `JSON.parse` 业务 payload；日志只允许记录安全元数据
  （`zcode_type` / `requestId` / `bridgeSessionId` / 字节数）。
- 单条物理 JSON 上限 1 MiB（与桌面 `WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes`
  对齐）；超限直接断开该连接。
- 未配对（`pair_status` 非 `matched`）时收到的 `data` 丢弃，不缓存、不排队。

### 错误码

| code             | 触发                                                   |
| ---------------- | ------------------------------------------------------ |
| `AUTH_FAILED`    | proof 不匹配、`device_sid` 未注册但以 `auth_init` 首连 |
| `DEVICE_OFFLINE` | terminal 指定了不存在的 `device_sid`                   |
| `KICKED`         | 同一 device 被新 terminal 顶替（发给旧 terminal）      |
| `WRONG_PARAM`    | 缺少必需字段、角色非法、协议版本不符                   |
| `INTERNAL`       | relay 内部异常（如转发时对端已消失）                   |

### 心跳与失联

- 心跳**完全由客户端本地维护**（8~12s jitter，30s ACK watchdog），relay 只负责回 `pair_status_ack`，
  不保存、不广播客户端的调度时间。
- relay 侧只做被动的 socket close 检测：一端断开即解除配对，把另一端置为可重新配对状态。

## 所有权与不变式

- relay **唯一持有**：device 注册表（`device_sid → {device_mid, pass_hash, socket, terminalSid}`）、
  terminal 注册表（`terminalSid → {deviceSid, socket}`）、配对关系。
- relay **不得持有**：ZCode task、session、conversation、queue、snapshot、permission、workspace 业务状态，
  也不得推断业务语义。
- 一个 `device_sid` 同时最多一个已认证 terminal。
- `pass_hash` 只进内存注册表，不落盘、不进日志。
- 业务 payload 的字节流必须保持逐字节透明，不得重排、合并或重编码。

## 失败语义

- 上述错误码均通过 `error {code, message}` 下发；下发后连接保持（除 `KICKED` 与超限外），
  由客户端决定是否重连。
- relay 进程崩溃/重启：所有连接断开；桌面 device 会重新注册并恢复（见设计决策 5），
  手机 terminal 需要重新走二维码或刷新页面。
- 内存注册表满（设备数上限，默认 64）时新注册返回 `error: INTERNAL`。

### 桌面侧：连不上 relay 时的可见失败（`web-remote-replayable` 弹层）

桌面 `WebRemoteControlDeviceTransport` 对"能否连上 relay"分两类处理，判据是
**TCP/WS 握手是否成功过一次**（`relayReachedOnce`，在 socket `open` 时置位）：

| 情形                                               | 处理                                                                                                | 用户可见                                                                                                                                                                  |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 从未连上过（relay 未启动 / 地址写错 / 防火墙拦截） | 最多重试 `WEB_REMOTE_CONTROL_MAX_INITIAL_CONNECT_ATTEMPTS`（默认 6）次，随后停在 `error` 不再自重启 | 弹层常驻一条可读错误，含 relay 地址、底层原因（如 `ECONNREFUSED`）与处置动作（relay 默认由本应用托管；指向外部 relay 时提示检查 `ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL`） |
| 曾经连上过（已配对会话遇到 relay 短抖动）          | 沿用既有**无限重连** + 宽限期，不设预算                                                             | 已配对会话在宽限期内保持 active；手机拿旧二维码回来可恢复                                                                                                                 |

边界与不变式：

- 预算只约束"start 之后从未握手成功"的连接；握手成功过一次后永久解除，不受后续掉线时长影响。
- 停在 `error` 后必须自愈只能靠用户动作：关掉再开弹层会 `dispose()` 旧 transport 并新建
  （`start()` 复位全部计数），因此预算会被重置。
- `error` 状态必须带真实原因：manager 从 `transport.getLastError()` 取回并写入
  `status.error`；只切状态不填消息会让 UI 退化成固定的"无法启动移动端远程控制。"，用户无从判断该做什么。
- 这条约束的动机是修复一类真实缺陷：无差别无限重连会把 `error` 每 2 秒洗回
  `starting`，表现为"一直启动中、偶尔闪一下报错、二维码永远不出现"。

## 迁移边界

- **不改**桌面、手机、共享协议的任何行为；本变更是纯新增 entry。
- 不触碰官方 relay 的行为与默认值（`wss://zcode.z.ai/ws` 仍是默认）。
- 自建部署通过环境变量切换，不写死：
  - `ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL=ws[s]://<relay-host>/ws`（桌面）
  - `ZCODE_WEB_REMOTE_CONTROL_URL=http[s]://<pwa-host>/remote/v4`（桌面二维码指向的 PWA 地址）
- 若自建 PWA 托管在 relay 上，另需 `ZCODE_WEB_STATIC_ROOT=<packages/web/dist>`。

## 实现现状

| 文件                                                        | 职责                                                                                                                             |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `src/relay/relayAuth.ts`                                    | 鉴权原语与常量时间比较（与桌面 `webRemoteControlRelayAuthProvider.ts` 逐位一致）                                                 |
| `src/relay/webRemoteControlRelayRegistry.ts`                | 内存注册表唯一所有者：device/terminal/连接三表、单 terminal 不变式、容量回收、kick/retire/displace 簿记；不做协议解析与 I/O      |
| `src/relay/webRemoteControlRelayHub.ts`                     | 控制面状态机：帧解析、注册、auth challenge/proof 校验、配对状态应答、错误码下发                                                  |
| `src/relay/webRemoteControlRelayDataPlane.ts`               | 数据面：`data` 帧按原始文本逐字节透传                                                                                            |
| `src/relay/relayFrameFields.ts`                             | 纯函数：信封形状校验、必填字符串读取、日志安全元数据                                                                             |
| `src/relay/relayStaticAssets.ts`                            | 可选 PWA 静态托管（SPA fallback + 路径穿越防护）                                                                                 |
| `src/relay/relayHttpServer.ts`                              | **服务端引导的唯一实现**：`node:http` + `ws`、`/ws` 升级、routing hint、1 MiB 帧上限、`/healthz`、静态托管；CLI 与桌面进程内共用 |
| `src/relay/lanHost.ts`                                      | 私网地址探测与绑定地址选择（默认只绑私网，绝不回退 0.0.0.0）                                                                     |
| `src/relay/index.ts`                                        | `@zcode/server/relay` 公开入口，只导出能力与类型                                                                                 |
| `src/entry-relay.ts`                                        | 命令行入口：读环境变量后调用上面的引导实现，自身不再含服务逻辑                                                                   |
| `tsup.relay.config.ts`                                      | 独立构建（`pnpm --filter @zcode/server run build:relay`）                                                                        |
| `packages/desktop/src/main/webRemoteControlRelayHost.ts`    | **桌面进程内托管 relay 的唯一所有者**：按用户触发启动/停止、端口占用递增探测、dev/packaged 静态根解析                            |
| `packages/desktop/scripts/prepare-mobile-remote-bundle.mjs` | 打包前 staging PWA（剥 sourcemap）；`beforePack` 调用，`extraResources` 拷到 `resources/mobile-remote`                           |
| `packages/web/src/main.tsx`                                 | 手机端 relay 地址按运行期 `window.location.origin` 推导（原为构建期 `VITE_ZCODE_BASE_URL`），换网络无需重编                      |

## 与初版设计的差异（实现选择，均已固化测试）

1. **配对记录跨瞬断保留**：device socket 断开时保留注册条目与 `terminalSid`，`matched` 以"已鉴权的
   device socket 存在"为门。桌面用持久化 `device_sid` 重连即恢复 `matched`，手机不必重新扫码。
   relay 进程真正重启时状态全丢，仍走 `AUTH_FAILED` → 重新注册路径。
2. **`pair_status_query` 只允许查询本条连接鉴权时绑定的 `device_sid`**，跨设备探测返回 `WRONG_PARAM`。
3. **`auth_ack` / `pair_status_ack` 在 matched 时附带 `terminal_sid`**（字段可选，两端均忽略未知字段）。
4. **超限帧用 `socket.terminate()` 直接断开**，同时以 ws `maxPayload` 作传输层硬闸。
5. 新增环境变量（均有默认值）：`ZCODE_RELAY_MAX_DEVICES`（默认 64）、`ZCODE_RELAY_DEBUG=1`、
   `ZCODE_RELAY_HOST`（与既有 `HOST` 并列，优先级同 `entry-http.ts` 的 `ZCODE_SERVER_HOST`）。

## 部署

relay 不依赖任何云端账号；桌面与手机经它互通，**relay 不接触业务内容**。
relay 的服务端引导实现只有一份 `src/relay/relayHttpServer.ts`，被两种形态共用。

### 默认方式：桌面进程内托管（用户零操作）

用户在桌面弹层里打开手机远控，桌面 main 自己把 relay 拉起来并托管 PWA：

```
手机 PWA ──ws──► [桌面 main 进程内的 relay] ◄──ws── [桌面 device transport]
                      └─ 同时托管 PWA 静态资源
```

| 维度     | 行为                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------ |
| 触发     | 第一次打开远控功能时启动；用户点「退出」时随最后一个 runtime 一起停止                                              |
| 绑定地址 | 默认只绑私网 IPv4（192.168/10./172.16-31/169.254/CGNAT）；探测不到就明确报错，**绝不回退 0.0.0.0**                 |
| 端口     | 默认 3030，被占用时向上探测（上限 20 个）；二维码用**实际**端口而非 preferredPort                                  |
| 静态资源 | 开发态读仓库 `packages/web/dist`；打包态读 `resources/mobile-remote`（`prepare-mobile-remote-bundle.mjs` staging） |

用户完全不需要起进程、设变量、写配置。失败时会给出可自助处置的文案（无局域网地址 / 缺页面资源 / 端口用尽）。

### 逃生口：指向自建 relay（VPS 等场景）

```bash
ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL=wss://<domain>/ws
ZCODE_WEB_REMOTE_CONTROL_URL=https://<domain>/remote/v4/
```

设了 `RELAY_WS_URL` 后不再进程内托管，relay 生命周期由部署方负责。另有一个绑定地址逃生口
`ZCODE_WEB_REMOTE_CONTROL_RELAY_HOST=0.0.0.0`，仅用于容器/VPN 场景（默认策略不满足时才需要）。

> 此前"`pnpm remote:up` 把地址写进数据根 `mobile-remote.json`、桌面启动时读取"的路径已删除：
> 进程内托管让桌面成为 relay 的生命周期所有者后，磁盘配置就成了多余的第二条路径。

### 手工方式（自建常驻 relay）

```bash
pnpm --filter @zcode/server run build:relay
pnpm --filter @zcode/web run build   # 若想让 relay 顺带托管 PWA
PORT=3030 ZCODE_RELAY_HOST=0.0.0.0 \
  ZCODE_WEB_STATIC_ROOT=packages/web/dist \
  node packages/server/dist/entry-relay.js
```

> 路由路径由构建期变量决定（`resolveWebRemoteControlRoutePath` 读
> `VITE_WEB_REMOTE_CONTROL_ROUTE_PATH` 或 `VITE_ZCODE_BASE_URL` 的 pathname），必须与
> `--base` 对齐；只传 `--base` 会落到 `/remote`，手机打开 `/remote/v4/` 时走错分支。

**方案一：局域网（零公网暴露，最安全）**——默认的进程内托管就是这一档，无需任何常驻进程。

**方案二：VPS 公网**——relay 放 VPS，务必套 TLS 反代（`wss://`），且建议只放行必要来源；
此时桌面改用上面的环境变量逃生口。

**安全姿态**：默认只绑私网地址；配对走 pass_hash + nonce 的一次性 HMAC 挑战；每设备独立 token；
relay 只见 opaque 帧；`pass_hash` 不落盘不进日志。仍建议：VPS 场景开 TLS、按需限制来源 IP、
并保持 `ZCODE_RELAY_MAX_DEVICES` 收敛。

## 验收场景

- **A1 配对**：device 注册→auth→`waiting`；terminal 扫码→`matched`；双向 `data` 逐字节透传。
- **A2 鉴权向量**：relay 侧 `calculateProof` 对
  `WEB_REMOTE_CONTROL_RELAY_AUTH_PROOF_VECTORS` 中 device/terminal 两条向量全部命中。
- **A3 单 terminal**：第二个 terminal 接入时旧 terminal 收到 `KICKED` 且被断开，新 terminal 正常 `matched`。
- **A4 重启自愈**：relay 重启后 device 收到 `AUTH_FAILED` → 自动重新注册 → 恢复 `waiting/matched`。
- **A5 端到端**：手机经自建 relay 打开桌面**本地**工作区会话与桌面已连的 **WSL 远端**工作区会话，
  发送消息后桌面侧执行并回流转发；手机断网恢复后按 replayable 快照恢复，会话不丢。
- **A6 不透传失败**：未配对状态下 `data` 被丢弃；超限帧导致断连。
