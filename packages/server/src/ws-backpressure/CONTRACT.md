# ws-backpressure

意图：`/ws` 出口的发送侧背压。`ws` 没有 drain 事件、`send()` 也不等对端消费，弱网慢消费者会让
服务端进程内的待发字节（`bufferedAmount`）无界增长、堆内存失控。本模块补两条防线，
试运行发现 drain 在全链路**没有任何 awaiter**，所以只把 drain 做真不产生背压，水位才是真有界的那一半。

不变量：

- **单个 WS 连接的进程内待发字节有上界** ≈ 4MiB 高水位 + 在途余量（SAT RPC 往返期间 CLI 已发出的帧、
  stdio 管道内帧、订阅 ACK 时 staging 一次性释放 ≤32MiB）。慢消费者不能让堆内存随时间无界增长。
- **边沿触发 + 滞回**：越过 `SEND_SATURATED_BYTES`(4MiB) 报一次 SAT，回落到 `SEND_DRAINED_BYTES`(512KiB)
  以下报一次 DRN；饱和期间不重复触发，再次越过高水位重新 SAT。低水位取 1/8 是为了抗抖动。
- **接了 `send()` 的帧不丢**：`write` 不做水位拒绝，背压靠 SAT 让上游停止生产。
- `drain` 只等「已入队字节写完」：空闲立即 resolve，`close`/`error`/`dispose` 一律收口 resolve 而不 reject。
- 探测定时器只在「有 drain 等待者或处于饱和态」时存在（且 `unref`，不阻止进程退出），空闲连接不挂定时器。
- 一个连接的 SAT 只暂停该 connectionId 的 flush，不影响同一 CLI 上的其它连接；SAT/DRN 提交必须保序，
  `close` 之后的迟到边沿不得复活 CLI 的 pause。

交集与 hook 点：

- 转发链：`wrapWebSocket` 观测水位 → `attachSendFlowControl`（按序串行）→ `connectionScope.setTransportFlowState`
  → `base.setConnectionFlowStateV4` → CLI `v4-gateway.setConnectionFlowState` → `pausedConnections` 停 flush。
  服务端是发送方，拥塞的上游是同进程 CLI 的帧源，因此走本机 RPC 而不是给客户端发消息
  （`/ws` 的 SocketProtocol 没有控制帧，对端也不消费 flow state）。
- 转发 RPC 失败只记日志、连接照常（退化为改动前的无界增长），不阻塞任何流量。

规格：`packages/server/spec/websocket-send-backpressure.md`（含慢客户端最终表现与三处同源 fake drain 的遗留）。
