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

## 迁移边界

- **不改**桌面、手机、共享协议的任何行为；本变更是纯新增 entry。
- 不触碰官方 relay 的行为与默认值（`wss://zcode.z.ai/ws` 仍是默认）。
- 自建部署通过环境变量切换，不写死：
  - `ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL=ws[s]://<relay-host>/ws`（桌面）
  - `ZCODE_WEB_REMOTE_CONTROL_URL=http[s]://<pwa-host>/remote/v4`（桌面二维码指向的 PWA 地址）
- 若自建 PWA 托管在 relay 上，另需 `ZCODE_WEB_STATIC_ROOT=<packages/web/dist>`。

## 实现现状

| 文件                                                   | 职责                                                                                                                        |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `src/relay/relayAuth.ts`                               | 鉴权原语与常量时间比较（与桌面 `webRemoteControlRelayAuthProvider.ts` 逐位一致）                                            |
| `src/relay/webRemoteControlRelayRegistry.ts`           | 内存注册表唯一所有者：device/terminal/连接三表、单 terminal 不变式、容量回收、kick/retire/displace 簿记；不做协议解析与 I/O |
| `src/relay/webRemoteControlRelayHub.ts`                | 控制面状态机：帧解析、注册、auth challenge/proof 校验、配对状态应答、错误码下发                                             |
| `src/relay/webRemoteControlRelayDataPlane.ts`          | 数据面：`data` 帧按原始文本逐字节透传                                                                                       |
| `src/relay/relayFrameFields.ts`                        | 纯函数：信封形状校验、必填字符串读取、日志安全元数据                                                                        |
| `src/relay/relayStaticAssets.ts`                       | 可选 PWA 静态托管（SPA fallback + 路径穿越防护）                                                                            |
| `src/entry-relay.ts`                                   | Node 入口：`node:http` + `ws`，`/ws` 升级、routing hint、1 MiB 帧上限、`/healthz`                                           |
| `tsup.relay.config.ts`                                 | 独立构建（`pnpm --filter @zcode/server run build:relay`）                                                                   |
| `scripts/start-mobile-remote.mjs`（仓库根）            | 一键启动：构建 relay+PWA、探测局域网 IP、起服务并托管 PWA、把地址写进桌面数据根、打印指引（`pnpm remote:up`）               |
| `packages/web/src/main.tsx`                            | 手机端 relay 地址改为按运行期 `window.location.origin` 推导（原为构建期 `VITE_ZCODE_BASE_URL`），换网络无需重编             |
| `packages/desktop/src/main/localMobileRemoteConfig.ts` | 桌面读数据根 `mobile-remote.json`；只接受回环/私有网段的明文 ws/http，防配置被篡改后指向外部 relay                          |

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

### 一键方式（推荐）

```bash
pnpm remote:build   # 构建 relay + 手机端 PWA（只需一次，产物与网络无关）
pnpm remote:up      # 起服务并打印：手机要开的地址 + 桌面要注入的环境变量
```

`scripts/start-mobile-remote.mjs` 会做：检测局域网 IPv4（虚拟网卡排后、常见家用网段优先）→
以 `ZCODE_WEB_STATIC_ROOT=packages/web/dist` 启动 relay 并托管 PWA → 等 `/healthz` 就绪 →
打印手机访问地址与桌面环境变量；多网卡时列出备选地址。`Ctrl+C` 一并停掉 relay。
支持 `--port <n>`、`--skip-build`、`--build-only`。

**为什么只需构建一次**：relay 地址在手机端是**运行期按 `window.location.origin` 推导**的
（`packages/web/src/main.tsx` 的 `resolveExternalRelayWsUrl`；官方部署 PWA 与 relay 同源，
推导结果不变），换 Wi-Fi、换 IP、换端口都不必重新构建。路由路径 `/remote/v4` 是构建期常量，
与网络无关。

### 手工方式

```bash
pnpm --filter @zcode/server run build:relay
VITE_WEB_REMOTE_CONTROL_ROUTE_PATH=/remote/v4/ \
  pnpm --filter @zcode/web exec vite build --base=/remote/v4/
PORT=3030 ZCODE_RELAY_HOST=0.0.0.0 \
  ZCODE_WEB_STATIC_ROOT=packages/web/dist \
  node packages/server/dist/entry-relay.js
```

> 路由路径由构建期变量决定（`resolveWebRemoteControlRoutePath` 读
> `VITE_WEB_REMOTE_CONTROL_ROUTE_PATH` 或 `VITE_ZCODE_BASE_URL` 的 pathname），必须与
> `--base` 对齐；只传 `--base` 会落到 `/remote`，手机打开 `/remote/v4/` 时走错分支。

**桌面侧地址来源**（优先级：环境变量 > 数据根 `mobile-remote.json` > 官方默认）：

```bash
ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL=ws://<relay-ip>:3030/ws
ZCODE_WEB_REMOTE_CONTROL_URL=http://<relay-ip>:3030/remote/v4/
```

`pnpm remote:up` 会自动把这两个值写进桌面数据根的 `mobile-remote.json`
（`getZCodeDataRootDir()/mobile-remote.json`，自建版为 `~/.zcode-rayn/`），因此**自建用户不需要设
任何环境变量**：跑 `pnpm remote:up` → 重启桌面 → 扫码即可。桌面读该文件的实现是
`packages/desktop/src/main/localMobileRemoteConfig.ts`。

该文件只被允许指向**回环或私有网段的明文 ws/http** 地址：文件在用户数据目录里，理论上可被本机
其他程序改写，若允许指向任意公网主机，就能把桌面连到伪造 relay 从而截获二维码里的 `passHash`。
所以公网域名一律要求走环境变量（这是有意的显式选择）。

**方案一：局域网（零公网暴露，最安全）**——relay 跑在家里/公司常开的机器上，只绑局域网地址。

**方案二：VPS 公网**——relay 放 VPS，务必套 TLS 反代（`wss://`），且建议只放行必要来源；
此时把 `ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL` 换成 `wss://<domain>/ws`。

**安全姿态**：桌面零入站端口（只连出 relay）；配对码一次性短 TTL；每设备独立 token；
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
