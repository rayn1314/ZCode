import type { SessionId } from "@zcode/contracts";
import type {
  PermissionBrokerPort,
  PermissionBrokerRequest,
  PermissionBrokerRequestOptions,
} from "../deps.js";
import {
  buildSubagentInteractionOrigin,
  type SubagentInteractionOriginContext,
} from "../../subagent/interaction-origin.js";

export interface SubagentInteractionBrokerContext extends SubagentInteractionOriginContext {
  parentToolCallId?: PermissionBrokerRequest["toolCallId"] | string;
}

type BrokerResponse = ReturnType<PermissionBrokerPort["requestPermission"]>;

export function createSubagentInteractionBroker(
  parentBroker: PermissionBrokerPort,
  context: SubagentInteractionBrokerContext,
): PermissionBrokerPort {
  return {
    requestPermission(
      request: PermissionBrokerRequest,
      options?: PermissionBrokerRequestOptions,
    ): BrokerResponse {
      // 修复原因：子 agent 的 permission / AskUserQuestion / ExitPlanMode 都需要父 task 的 UI 响应；
      // broker request 对外路由到父 session，origin 保留 child 归属，便于 UI 与日志识别来源。
      // 契约（2026-09-17 review）：registered 只是挂在 Promise 上的属性；本函数必须原样返回父 broker 的
      // 响应对象，不得改成 async 或加 .then 重新包装，否则信号静默丢失、executor 退回同步登记假设并
      // 重新引入"确认窗可见但 deferred 未登记"的竞态。subagent-interaction-broker.test.ts 守护该同一性。
      //
      // 本包装可以叠加，但两个方向的裁决点不同：
      // - `sessionId` 由**最后一层**（离真实 broker 最近、真正发反向 RPC 的那层）改写决定；
      // - `origin` 反过来保留**最先设置它的那层**（`??` 短路），所以嵌套派发时归属仍是真正发起
      //   请求的那个子代理，不会被外层覆盖成中间层。
      // 结构上不会出现"两层带不同父 id"的情况：子会话不得再派生子会话（D8），实战中每层都指向
      // 同一个根会话，因此"最终落根会话"是结构性的。冷恢复路径复用同一套规则，见
      // `core/spec/subagent-permission-parity.md` D2。
      return parentBroker.requestPermission(
        {
          ...request,
          sessionId: context.parentSessionId,
          origin: request.origin ?? buildSubagentInteractionOrigin(context, request.turnId),
        },
        options,
      );
    },
  };
}

/**
 * 只改写路由、不构造 origin 的窄包装。
 *
 * 供**冷恢复的存量子会话**使用：launch spec 里没有 `agentId` / `description`（改造前落库的规格
 * 缺这两个字段），而 origin 的 agentId 不能编造——它同时是 `SendMessage` 的寻址键。此时
 * "把询问送到父会话"仍然成立且必须成立（落子会话自己的 id 时 UI 几乎没有出口，见
 * `core/spec/subagent-permission-parity.md` D2），只是少了来源徽标这层归属信息。
 */
export function createSubagentInteractionRoutingBroker(
  parentBroker: PermissionBrokerPort,
  parentSessionId: SessionId,
): PermissionBrokerPort {
  return {
    requestPermission(
      request: PermissionBrokerRequest,
      options?: PermissionBrokerRequestOptions,
    ): BrokerResponse {
      return parentBroker.requestPermission({ ...request, sessionId: parentSessionId }, options);
    },
  };
}
