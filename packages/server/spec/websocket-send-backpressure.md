# WebSocket 出口发送背压（drain 与水位）spec

涉及其它包（仅作契约/调用方引用，本轮无改动）：`packages/rpc`（`ISocket`、`SocketProtocol`、
`IMessagePassingProtocol.drain?`）、`packages/services`（connection scope 的
`setTransportFlowState`）、`apps/zcode-cli`（`v4-gateway.setConnectionFlowState` 消费端）。

主责文件：`packages/server/src/websocketBackpressure.ts`、`packages/server/src/http.ts`。

## 背景与问题

弱网下手机/Web 客户端消费慢，服务端 `/ws` 出口却只查 `readyState` 就 `ws.send()`，
`drain()` 恒 `Promise.resolve()`，没有任何发送侧水位观测：

- `ws` 的发送队列（`bufferedAmount`，即进程内未写入 socket 的字节）随慢消费者无界增长，
  服务端堆内存随之失控——这是本轮要修的事故路径。
- 已有防线都在更上游且不覆盖这一层：CLI 订阅者 flush buffer 500 ops/1MiB 超限清空 + 整帧
  resync；connection staging 1024 帧/32MiB 溢出丢帧标 overflow；stdio 出口有真 drain。
  它们防止的是「上游缓冲无界」，防不了「服务端往 socket 里无限塞」。

### 调查结论：`drain()` 在链路里没有任何 awaiter

- `ChannelServer.send` 同步 fire-and-forget（`channelServer.ts`）：`protocol.send()` 之后不等
  `drain`，事件/响应帧直接进 socket。
- 全仓 grep：`SocketProtocol.drain` / `PersistentProtocol.drain` 只是把 `drain()` 转发给
  `socket.drain()`，而 `protocol.drain()` 本身零调用者；`IMessagePassingProtocol.drain?` 也无人
  await。
- 因此**只把 drain 做真不产生背压**：它传不到 staging / 订阅 buffer，也不会死锁或卡住入站
  处理（因为根本没人等它）。本轮把 drain 补成与 stdio 对齐的契约真相，并另起第二条防线
  （水位 → SAT）实现真正有界。
- 不在 `ChannelServer`/`SocketProtocol` 里 await drain：那要把发送改成异步队列，涉及
  「响应帧与事件帧排队、关闭时队列去留」的新语义，与入站处理的隔离也要一并设计，另立任务。

## 设计决策：两条防线

### 防线一：`drain()` 做真（传输契约，与 stdio 对齐）

- `bufferedAmount === 0` 或连接已关闭 → 立即 resolve。
- 否则注册等待者，由 20ms 轮询（`unref`，不阻止进程退出）在归零时 resolve。
  选轮询而非 `ws.send` 回调 / `ws._socket` 事件：`ws` 没有公开的 drain 事件，`_socket` 是私有
  字段，`bufferedAmount` 是唯一稳定的公开水位读数；drain 只在「所有已入队字节写完」时结束，
  轮询它语义最准。
- `close` / `error` / `dispose` 一律**收口 resolve**（不 reject）：连接关闭 = 「没有更多可写」，
  与 stdio drain 不区分错误的语义一致，避免等待者悬挂。
- `write()` 不做水位拒绝：接了 `send()` 的帧绝不丢（与 persistent-protocol 的既有原则一致），
  背压靠防线二让上游停止生产。

### 防线二：发送水位 → 既有 SAT/DRN 连接流控链

- 常量：`SEND_SATURATED_BYTES = 4MiB`（越过后报 SAT）、`SEND_DRAINED_BYTES = 512KiB`
  （饱和后回落到该值以下报 DRN），均为**边沿触发**。依据：v4 单帧上限 1MiB、订阅者 flush
  buffer 上限 1MiB/500ops，正常突发低于 4MiB 不误触发；SAT→CLI 暂停是一轮本机 RPC 往返，
  高水位要给这段在途帧留余量；低水位取高水位 1/8 形成滞回，避免反复抖动。
- 转发链（与 desktop host 的 MessagePort `onFlowState → setTransportFlowState` 同构，只是
  信号来源不同：desktop 从对端 sideband 收，server 从自己的 socket 收）：

  ```text
  wrapWebSocket 观测 bufferedAmount 边沿
    → attachSendFlowControl（按序串行，close 后拦截迟到 edge）
    → connectionScope.setTransportFlowState(saturated|drained)
    → base.setConnectionFlowStateV4（带 trusted carrier）
    → CLI v4-gateway.setConnectionFlowState
    → pausedConnections 停 flush / 恢复补发
  ```

- 关闭路径不变：`socket.onClose → connectionScope.dispose()`，内部发 `closed`，CLI 解除 pause
  并清理该连接的 attachment 上传登记。

### SAT 为什么不对客户端发 `connection-flow-v1`（方向性结论）

1. **协议层不支持**：`connection-flow-v1` 是 MessagePort 的 postMessage 控制对象；`/ws` 走
   `SocketProtocol`，是 13 字节头的二进制帧协议，没有控制帧类型——塞进去会破坏对端分帧。
2. **对端不消费**：浏览器端（`packages/client` 的 SocketProtocol）没有任何 flow state 消费方；
   `MessagePortProtocol.sendFlowState` 全仓零调用者（桌面 renderer→host 那段同样没接，接收端
   `onFlowState` 空等）。给不处理的对端发消息等于没发。
3. **语义方向**：SAT 是「接收端 → 上游生产者」的信号（桌面链路：renderer 收不动 → host →
   CLI 停 flush）。服务端是**发送方**，让它拥塞的上游生产者是同进程的 CLI 帧源，本地把水位边沿
   转成 `setConnectionFlowStateV4` RPC 即可，不需要也不应该绕道客户端。

结论：**不是降级**——wire 层不新增协议，直接走既有 RPC；「服务端→客户端方向的 flow state
通知」确认对端不支持，列入遗留。

## 行为

- `write`：连接非 OPEN 或已收口时直接返回（保持原语义）；写入后观测 `bufferedAmount`，
  首次 ≥4MiB 触发一次 `onSaturated`，饱和期间不重复触发。
- 饱和后 `bufferedAmount` 回落 ≤512KiB 触发一次 `onDrained`；再次越过高水位重新 SAT。
- `drain`：空闲立即 resolve；否则等轮询归零；关闭时收口 resolve。
- `attachSendFlowControl`：SAT/DRN 按提交顺序转给 scope（快速交替不乱序），`close` 之后的新
  edge 不再转发；scope 缺席（无 agent service）时空转。
- 探测定时器只在「有 drain 等待者或处于饱和态」时存在，空闲连接不挂定时器。

## 所有权与不变式

- **所有权**：`websocketBackpressure` 拥有 socket 水位状态、drain 等待者与探测定时器；
  connection scope 拥有 SAT/DRN → RPC 的串行提交与 closed 拦截；CLI gateway 拥有
  `pausedConnections`。任何一层都不复制另一层的状态。
- **不变式（核心）**：服务端向单个 WS 连接的**进程内待发字节有上界**
  ≈ 4MiB 高水位 + 在途余量（SAT RPC 往返期间 CLI 已发出的帧、stdio 管道内帧、订阅 ACK 时
  staging 一次性释放 ≤32MiB）。慢消费者不能让服务端堆内存随时间无界增长。
- 一个连接的 SAT 只暂停该 connectionId 的 flush，不影响同一 CLI 上的其它连接。

## 失败语义

- **慢客户端最终表现（不再 OOM）**：SAT 停 CLI flush → CLI 订阅者 buffer 涨到 500 ops/1MiB →
  溢出清空 + 整帧 resync（客户端恢复后收全量快照）；服务端 staging 涨到 1024 帧/32MiB →
  订阅显式失败（`initialFrameStagingOverflow`）而非静默缺片；socket 队列钉在 4MiB + 在途。
- **SAT 转发 RPC 失败**：只记日志，连接照常（退化为改动前的无界增长，但不阻塞任何流量）；
  route 级去重缓存只在成功后更新，下一个 edge 会重试。
- **连接关闭**：drain 等待者全部 resolve、定时器停止、scope 发 `closed`；close 之后迟到的
  SAT 被 attach 层与 scope 层双重拦截，不会复活 CLI pause。
- **SAT 时 runtime 已退出**：runtime lifecycle 事件先清空 owned routes，转发无路由可发，
  不会为了「暂停」拉起进程。

## 迁移边界 / 遗留

1. **SAT 对端方向性（结论已定，实现留待）**：`sendFlowState` 零调用者是发送侧的既有缺口；
   桌面 renderer→host 的链路同样没接（接收端已就绪）。若要让客户端感知服务端拥塞，需要
   应用层 credit/ACK（`/ws` 的 SocketProtocol 无 ACK），属于新协议设计，本轮不硬造。服务端
   侧不需要它（见上文方向性结论）。
2. **同源 fake drain（批量治理另立任务）**：
   - `packages/zcode-server-cli/src/server-core/http.ts`：与本 bug 同源（fake drain、无水位），
     且同样持有 connectionScope 可接 SAT——本轮未动，建议按本 spec 同法迁移。
   - `packages/client/src/websocket.ts`：浏览器端 drain 也是假的；浏览器无 drain 事件，可同法
     轮询 `bufferedAmount`。客户端是消费方、无内存压力，优先级低。
3. **ChannelServer 按 drain 节流**：见「调查结论」——需要异步有界发送队列与关闭语义，另立任务。
4. **请求驱动的大 RPC 响应**（attachmentRead 512KiB 分块、rowsRange 等）不受 SAT 约束，上界
   由客户端请求速率决定；弱网下客户端自身受同一链路限制，不在本轮范围。
5. **`/ws/remote/:id`（SSH 远端桥）**：没有 IZCodeAgentService connectionScope，只有真 drain、
   无 SAT；其上游是远端请求应答而非推送流。

## 验证

- 单测：`packages/server/test/websocketBackpressure.test.ts`
  （`node --import tsx --test packages/server/test/websocketBackpressure.test.ts`）。
