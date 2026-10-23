/**
 * ws-backpressure 对外契约：调用方要想正确调用就必须知道的一切都写在这里；其余对外不可见。
 *
 * 模块意图：`/ws` 出口的**发送侧**背压。`ws` 没有 stdio 那样的 drain 事件、`send()` 也从不等待
 * 对端消费，弱网慢消费者会让服务端进程内的发送队列（`bufferedAmount`）无界增长、堆内存失控。
 * 本模块做两件事：
 * 1. 把 `ISocket` 的 `drain()` 契约做真（与 `stdio.ts` 的 `writableNeedDrain` 语义对齐）；
 * 2. 把 `bufferedAmount` 的水位边沿交给 connection scope → CLI 暂停/恢复 flush。
 *
 * 设计、失败语义与不变式见 packages/server/spec/websocket-send-backpressure.md。
 */
export {
  SEND_DRAINED_BYTES,
  SEND_SATURATED_BYTES,
  attachSendFlowControl,
  wrapWebSocket,
} from "../websocketBackpressure.js";
export type {
  AttachSendFlowControlOptions,
  BackpressureSocket,
  WebSocketLike,
  WrapWebSocketOptions,
} from "../websocketBackpressure.js";

/**
 * `wrapWebSocket(ws, options)`：把一个 `ws` 实例包成 `BackpressureSocket`。
 * 前置：`ws` 只需实现结构类型 `WebSocketLike` 的那几个成员（便于测试注入 fake，也避免传输模块
 * 反向依赖 `@types/ws`）；水位常量与探测间隔由本模块决定，`pollIntervalMs` 仅供测试注入。
 * 后置（契约要点）：
 * - `write`：连接非 OPEN 或已收口时直接返回；**已接 `send()` 的帧绝不丢**——写入不做水位拒绝，
 *   背压靠 SAT 让上游停止生产（与 persistent-protocol 的既有原则一致）。
 * - `drain`：`bufferedAmount === 0` 或已关闭立即 resolve；否则注册等待者，由轮询（定时器
 *   `unref`，不阻止进程退出）在归零时 resolve。`close` / `error` / `dispose` 一律**收口 resolve**
 *   而不 reject（连接关闭 = 没有更多可写，与 stdio drain 不区分错误一致），不留下悬挂的等待者。
 * - `onSaturated` / `onDrained`：**边沿触发**，饱和期间不重复触发；登高水位 → 一次 SAT，
 *   回落到低水位以下 → 一次 DRN，再越过 → 再来一次。低水位取高水位 1/8 形成滞回，避免抖动。
 * - 探测定时器只在「有 drain 等待者或仍处饱和态」时存在，空闲连接不挂定时器。
 * - 无持久化、不发协议帧、不阻塞入站处理；本层不 await drain（全链路当前没有 awaiter，
 *   在 ChannelServer 按 drain 节流需要异步有界发送队列，另立任务）。
 */

/**
 * `attachSendFlowControl(socket, resolveScope, options)`：把 SAT/DRN 边沿串行转成 connection scope
 * 的传输流控（scope → `setConnectionFlowStateV4` RPC → CLI gateway 暂停该 connectionId 的 flush）。
 *
 * 前置：`resolveScope` 用 getter 注入，因为 scope 的创建晚于 socket 包装；scope 缺席（无 agent
 * service）时整体空转，不为了「暂停」拉起进程。
 * 后置：**按序提交**——快速 SAT→DRN 交替不能乱序（一次 RPC 失败不打断后续 edge 的提交，只走
 * `onForwardError` 上报并退化为改动前的无界增长）；`onClose` 之后到达的迟到 edge 不再转发，
 * 不会复活 CLI 的 pause。SAT 只暂停该 connectionId 的 flush，不影响同一 CLI 上的其它连接。
 * 不变式（核心）：服务端向单个 WS 连接的进程内待发字节有上界
 * ≈ 4MiB 高水位 + 在途余量；慢消费者不能让服务端堆内存随时间无界增长。
 */
