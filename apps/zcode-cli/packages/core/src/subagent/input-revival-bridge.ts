// ============================================================
// 子代理输入复活桥（spec `subagent-input-revival.md` D2）
// ============================================================
//
// 父子会话同进程但分属两个 runtime：子会话的输入轮（v4 sendText 直发）在子 runtime
// 执行，而任务状态与父通知能力都在父侧（SubagentPort / 父 registry）。这座桥按
// `childSessionId` 登记两侧共需的引用，让子 runtime 的轮开/收两点能找到结算 owner。
//
// 桥是**纯内存登记表**，不是第二份任务状态：任务权威永远在 `runtimeTaskRegistry`，
// 通知能力永远在 `ExploreSubagentPortOptions` 指向的父 runtime。不落库、不跨进程；
// 跨进程的那一半由父会话冷恢复按持久化生命周期重新登记（spec D10），而不是让桥自己
// 变成持久化容器。

import type { SessionId } from "@zcode/contracts";

/** 桥上必须的最小身份面；完整绑定由 runner 侧扩展（选项与请求是 runner 私有类型）。 */
export interface SubagentInputRevivalBindingBase {
  agentId: string;
  childSessionId: SessionId;
  parentSessionId: SessionId;
  /**
   * 复活轮运行期的真实停止句柄：由子 runtime 在复活注册时安装、结算时清除。
   * `port.stopTask` 对 inputRevival 任务走它停轮——那种轮不在 runner 手里，
   * `abortControllers` 没有对应条目。消费即清（一次安装只停一次）。
   */
  stopTurn?: () => void;
}

const bindings = new Map<SessionId, SubagentInputRevivalBindingBase>();

/** 登记点：runner 构造任务快照的三处（派发 run / start、SendMessage 复活）。重复登记按后写覆盖。
 * 泛型让 runner 的完整绑定（含 options/registry/request）原样落表，桥只依赖最小身份面。
 */
export function registerInputRevivalBinding<T extends SubagentInputRevivalBindingBase>(
  binding: T,
): void {
  bindings.set(binding.childSessionId, binding);
}

/**
 * 查登记。泛型参数是 runner 私有绑定类型：桥自身不认识它的字段，只做一次受控收窄
 * （登记方与查询方都是 runner，类型不可能分叉）。
 */
export function getInputRevivalBinding<T extends SubagentInputRevivalBindingBase>(
  childSessionId: SessionId,
): T | undefined {
  return bindings.get(childSessionId) as T | undefined;
}

/** `port.stopTask` 停掉复活轮的真实执行；无登记或不在运行期（stopTurn 已清除）即 no-op。 */
export function requestStopInputRevivalTurn(childSessionId: SessionId | undefined): void {
  if (!childSessionId) return;
  const binding = bindings.get(childSessionId);
  if (!binding?.stopTurn) return;
  const stopTurn = binding.stopTurn;
  binding.stopTurn = undefined;
  stopTurn();
}

/**
 * 释放某个父会话登记的全部绑定（spec D10 边界 3）。
 *
 * 绑定持有父 runtime 的 `options` / `registry`，也就是整个 runtime 的活引用。父会话被
 * 空闲回收后若还留着这些登记，登记表会把已关闭的 runtime 钉在内存里，回收形同虚设。
 * 按 `parentSessionId` 而不是按 key 清：key 是**子会话** id，属于父会话的绑定不止一条。
 */
export function releaseInputRevivalBindingsForSession(parentSessionId: SessionId): void {
  for (const [childSessionId, binding] of bindings) {
    if (binding.parentSessionId === parentSessionId) bindings.delete(childSessionId);
  }
}
