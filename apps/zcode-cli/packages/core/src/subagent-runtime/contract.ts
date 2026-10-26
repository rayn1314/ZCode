/**
 * subagent-runtime 对外契约
 * （spec: apps/zcode-cli/packages/core/spec/subagent-session-as-first-class.md、
 *  subagent-seat-gate-and-registry-bounds.md、subagent-lifecycle-orphan-reconciliation.md、
 *  subagent-input-revival.md、subagent-continuation-copy.md）。
 *
 * 模块意图：把一个子代理当作**一等会话**来治理——有并发上界（座位闸门）、有终态与续跑语义、
 * 有跨重启可读的历史投影（roster）、有进程死亡后的冷恢复对账，以及父子两侧共用的输入复活登记。
 *
 * 类型表达不了的不变量：
 * - **唯一真相源**：任务状态永远在 `runtimeTaskRegistry`，历史只存在于父会话的
 *   `runtime/subagent_lifecycle` session entry（一个 agentId 一行，spawn 建行、stop 覆写同一行）；
 *   roster 端口是**只读**投影，不得写状态、不得成为第二个真相源。
 * - 历史投影的状态语义必须保守：只有 spawn、没有终态的行报 `lost`，**绝不报 `running`**
 *   （本进程注册表缺席时那个 runtime 已经不存在了，猜 running 会让模型发一条永远送不到的消息）；
 *   宿主进程死亡留下的 `lost` 行由下次接管时的对账认领成 `interrupted`。
 * - 座位闸门是纯的：不读时钟、不做 IO、不起定时器；容量每次 acquire **迟绑定**读取并 clamp 到 ≥ 1
 *   （上界 ≥ 1 ⇒ 永不死锁）；lease 是终局闩锁（重复 release 不多放座位），每个终态转换点必归还。
 * - 子会话不能再派子代理（`subagents.enabled: false` 是 fail-closed）：`Agent` 工具的注册门读的就是
 *   它；冷恢复拿不到 launch spec 时也必须写这一条，否则会重新长出套娃后门。
 * - launch spec 只存**推导不出来**的身份事实（工具白名单来自父 runtime 实时注册表、persona 只存
 *   `profileName`/`profileSource` 寻址键、`permissionMode`/`modelSelection` 各有专用 entry）；
 *   落盘失败只 warn，读取侧按「缺规格 → 受限模式」兜底。
 * - 输入复活桥是**纯内存**登记表，不落库：它承载「子 runtime 的轮由父侧结算」这层引用，
 *   任务权威仍在注册表、通知能力仍在父 runtime。跨进程的一半由父会话冷恢复按持久化生命周期
 *   重新登记（spec `subagent-input-revival.md` D10），桥自己不持久化。
 */
import type {
  ListAgentsAgent,
  ListAgentsInput,
  ListAgentsOutput,
  SubagentRosterEntry,
  SubagentRosterPort,
  SubagentTaskStatus,
} from "@zcode/contracts";
import {
  LIST_AGENTS_TOOL_NAME,
  ListAgentsAgentSchema,
  ListAgentsInputJsonSchema,
  ListAgentsInputSchema,
  ListAgentsOutputJsonSchema,
  ListAgentsOutputSchema,
  mapSubagentLifecycleStatus,
} from "@zcode/contracts";
import type { AgentRuntime } from "../runtime/agent-runtime.js";
import { listAgentsToolEntry } from "../tool/handlers/list-agents.js";
import {
  buildSubagentLifecycleEntry,
  persistSubagentLifecycleEntry,
  readLifecycleData,
  subagentLifecycleEntryId,
  type SubagentLifecycleEntryData,
} from "../runtime/methods/subagent-lifecycle-persistence.js";
import { reconcileOrphanedSubagentLifecycles } from "../runtime/methods/subagent-lifecycle-reconciliation.js";
import type {
  SubagentChildCoreDeps,
  SubagentChildLaunchBundle,
  SubagentChildRuntimeConfigOverrides,
  SubagentChildSessionHost,
} from "../subagent/child-session-host.js";
import {
  classifySubagentFailure,
  formatSubagentFailureGuidance,
  type SubagentFailureKind,
  type SubagentFailureRecovery,
} from "../subagent/failure-recovery.js";
import {
  getInputRevivalBinding,
  registerInputRevivalBinding,
  requestStopInputRevivalTurn,
  type SubagentInputRevivalBindingBase,
} from "../subagent/input-revival-bridge.js";
import {
  buildSubagentLaunchSpecEntry,
  persistSubagentLaunchSpec,
  subagentLaunchSpecEntryId,
} from "../subagent/launch-spec.js";
import {
  createSubagentSeatGate,
  getSubagentSeatGate,
  type SubagentSeatAcquireOptions,
  type SubagentSeatGate,
  type SubagentSeatGateStats,
  type SubagentSeatLease,
} from "../subagent/seat-gate.js";

export type {
  AgentRuntime,
  ListAgentsAgent,
  ListAgentsInput,
  ListAgentsOutput,
  SubagentChildCoreDeps,
  SubagentChildLaunchBundle,
  SubagentChildRuntimeConfigOverrides,
  SubagentChildSessionHost,
  SubagentFailureKind,
  SubagentFailureRecovery,
  SubagentInputRevivalBindingBase,
  SubagentLifecycleEntryData,
  SubagentRosterEntry,
  SubagentRosterPort,
  SubagentSeatAcquireOptions,
  SubagentSeatGate,
  SubagentSeatGateStats,
  SubagentSeatLease,
  SubagentTaskStatus,
};
export {
  LIST_AGENTS_TOOL_NAME,
  ListAgentsAgentSchema,
  ListAgentsInputJsonSchema,
  ListAgentsInputSchema,
  ListAgentsOutputJsonSchema,
  ListAgentsOutputSchema,
  buildSubagentLaunchSpecEntry,
  buildSubagentLifecycleEntry,
  classifySubagentFailure,
  createSubagentSeatGate,
  formatSubagentFailureGuidance,
  getInputRevivalBinding,
  getSubagentSeatGate,
  listAgentsToolEntry,
  mapSubagentLifecycleStatus,
  persistSubagentLaunchSpec,
  persistSubagentLifecycleEntry,
  readLifecycleData,
  reconcileOrphanedSubagentLifecycles,
  registerInputRevivalBinding,
  requestStopInputRevivalTurn,
  subagentLaunchSpecEntryId,
  subagentLifecycleEntryId,
};
// 生命周期 entry 只有这一条构造路径（对账也复用它）：出入参直接取自实现，不再另写一份形状。
export type SubagentLifecycleEntryBuildInput = Parameters<typeof buildSubagentLifecycleEntry>[0];
export type SubagentLifecycleEntryBuildOutput = ReturnType<typeof buildSubagentLifecycleEntry>;
/** 对账入参由实现推导：`this` 是会话 runtime，参数是 trace 上下文。 */
export type SubagentReconciliationTraceContext = Parameters<
  typeof reconcileOrphanedSubagentLifecycles
>[0];

/** 从一行 entry 解出的最小事实集（`undefined` = 结构损坏，按没有旧行处理）。 */
export type SubagentLifecycleRowFacts = ReturnType<typeof readLifecycleData>;

/**
 * 模块对外契约面。真实实现分散在本模块的实现文件里：
 * 座位闸门 `../subagent/seat-gate.js`、构造移交 `../subagent/child-session-host.js`、
 * 终态与续跑 `../subagent/failure-recovery.js`、生命周期落盘
 * `../runtime/methods/subagent-lifecycle-persistence.js`、冷恢复对账
 * `../runtime/methods/subagent-lifecycle-reconciliation.js`。
 */
export interface SubagentRuntimeContract {
  /**
   * 等一个驻留座位（子代理执行体并发上界）。
   *
   * 前置：`options.capacity` 是当前配置值（迟绑定，缺席沿用闸门当前读数）；`options.signal` 已 abort
   * 时立即拒绝、本次不占座。
   * 后置：上界内立即返回 lease，否则按 FIFO 排队到有人归还；lease `release()` 幂等（终局闩锁）。
   * 幂等：同一派发只应 acquire 一次并归还一次；重复 release 不多放座位。
   * 不产生事件、不持久化（纯内存）。
   */
  acquireSeat(options?: SubagentSeatAcquireOptions): Promise<SubagentSeatLease>;

  /**
   * 从 core 侧交出子会话的两半事实，换回一个已登记进 `context.sessions` 的 runtime。
   *
   * 前置：`bundle` 携带派发那一刻的父语境快照与父 runtime 的活端口（权限服务 / skill 端口 /
   * MCP 端口 / eventSink / modelFactory 等）；父 record 缺席或父 App 未借出装配事实时应抛错。
   * 后置：返回可直接跑首轮的 runtime；`bundle.resume` 为真时不重写 launch spec。
   * 不产生事件、不持久化（本调用是瞬态的，跨进程恢复靠 launch spec）。
   */
  createChildSession(bundle: SubagentChildLaunchBundle): Promise<AgentRuntime>;

  /**
   * 只读列出父会话的历史子代理（跨重启可读）。
   *
   * 前置：`parentSessionId` 是**父会话**主键；父会话不在本进程 / 宿主无持久化时返回空数组
   * （既不是故障也不是「没有历史」，只是本端口看不到）。
   * 后置：每 agentId 一行；状态只会是终态或 `lost`（`running` 只由本进程注册表断言）。
   * 真正的读取异常必须抛出——调用方据此标注 `historyUnavailable`，不得静默当成空列表。
   * 幂等：纯读，不写任何状态、不成为第二个真相源。
   */
  listHistoricalSubagents(
    parentSessionId: string,
    options?: { signal?: AbortSignal },
  ): Promise<SubagentRosterEntry[]>;

  /**
   * 子代理失败的「可续跑性」分类，供父代理决定续跑还是重派。
   *
   * 前置：`error` 是子代理终态原因（可能带 cause 链）。
   * 后置：返回 `transient | configuration | cancelled | inactive | unknown` 及 adapter 给的事实
   * （reason / retryable / statusCode / timeoutMs）；看门狗超时最先认（不冒充 provider 抖动）。
   * 幂等：纯函数。不产生事件、不持久化。指引文案经 `formatSubagentFailureGuidance` 生成，
   * 必须点名 agentId 的 `SendMessage` 句柄（父代理在工具结果里看不到 agentId）。
   */
  classifyFailure(error: unknown): SubagentFailureRecovery;

  /**
   * 把 `SubagentSpawned` / `SubagentStopped` 事件落成稳定 id 的 session entry。
   *
   * 前置：`event` 是父会话事件流里的生命周期事件；`existing` 是同一 agentId 的旧行（用于保留
   * 首次 spawn 的 created/startedAt）。
   * 后置：spawn/stop 覆写同一行（id = `subagent-lifecycle:<agentId>`，行数不随事件数增长）；
   * 不构成可寻址行（缺 agentId/childSessionId，或 stop 没有对应 spawn）时返回 `undefined`。
   * 幂等：同一事件重复落盘收敛为同一行。事件：不额外发事件（它就是事件流的派生事实）。
   * 持久化：调用方等待落盘；写失败只 warn，不打断生命周期。
   */
  buildLifecycleEntry(input: SubagentLifecycleEntryBuildInput): SubagentLifecycleEntryBuildOutput;

  /**
   * 本进程开始接管会话时，认领上一个进程丢下的子代理孤儿行，返回本次认领条数。
   *
   * 前置：`this` 上是已接管的会话 runtime（有 `sessionStore` / `runtimeTaskRegistry` / `logger`）。
   * 后置：判据三条同时成立才认领——roster 会显示成 `lost`、本进程注册表没有该 agentId、
   * 行早于本进程接管时刻；认领写成 `interrupted`（复用唯一构造路径，不 append 伪事件）。
   * 幂等：可重复调用；读失败/单行写失败只降级跳过，下次接管重试。能力缺席返回 0（不是故障）。
   */
  reconcileOrphanedLifecycles(traceContext: SubagentReconciliationTraceContext): Promise<number>;
}
