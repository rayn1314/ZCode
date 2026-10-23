/**
 * ws-backpressure 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 *
 * 前半段是 `packages/server/src/http.ts` 的 `/ws` 升级处实际做的事：包装 socket、接上流控转发；
 * 后半段是写一帧与（真有等待者时）等 drain 的用法。scope 用 getter 注入——它的创建晚于 socket 包装。
 */
import { VSBuffer } from "@zcode/rpc";
import type { ZCodeAgentConnectionScope } from "@zcode/services";
import { attachSendFlowControl, wrapWebSocket, type WebSocketLike } from "./contract.js";

/** 生产里是 `ws` 的实例；这里只用结构类型声明需要的成员（fake 也照同一个形状写）。 */
declare const socket: WebSocketLike;
declare const resolveScope: () => ZCodeAgentConnectionScope | undefined;

/** ① 包装：`drain` 变成真 drain，越过水位发一次 `onSaturated`、回落发一次 `onDrained`。 */
export const backpressureSocket = wrapWebSocket(socket);

/** ② 接流控：SAT/DRN 按序转给 connection scope → `setConnectionFlowStateV4` → CLI 暂停该连接 flush。 */
attachSendFlowControl(backpressureSocket, resolveScope, {
  onForwardError: (state, error) => {
    // 转发失败只降级为改动前的无界增长，不阻塞连接。
    console.warn("[ws-backpressure] 流控转发失败", state, error);
  },
});

/** ③ 写一帧：帧照常进 socket；背压由上游收到 SAT 后停止生产，而不是在写入处丢帧。 */
export function sendFrame(payload: string): void {
  backpressureSocket.write(VSBuffer.fromString(payload));
}

/** ④ 等 drain：只有真有等待者时才等——归零或连接关闭都会 resolve，不会悬挂。 */
export async function flushBeforeClose(): Promise<void> {
  await backpressureSocket.drain();
  backpressureSocket.dispose();
}
