/**
 * subagent-runtime 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 *
 * 座位闸门是该模块最常见的一次完整使用：派发前占座，终态转换点（前台 finally、转后台、后台
 * finally 都可能先到）必定归还。
 */
import {
  getSubagentSeatGate,
  type SubagentSeatAcquireOptions,
  type SubagentSeatLease,
} from "./contract.js";
import type { SubagentRuntimeContract } from "./contract.js";

export async function exampleSubagentRun<T>(input: {
  run: () => Promise<T>;
  options?: SubagentSeatAcquireOptions;
}): Promise<T> {
  const lease: SubagentSeatLease = await getSubagentSeatGate().acquire(input.options);
  try {
    return await input.run();
  } finally {
    // release 是终局闩锁：多个收口点先后调到同一个 lease，也只会放出一个座位。
    lease.release();
  }
}

/** 事件汇里落一行生命周期 entry（spawn 建行、stop 覆写同一行）。 */
export function exampleBuildLifecycleEntry(
  contract: Pick<SubagentRuntimeContract, "buildLifecycleEntry">,
  input: Parameters<SubagentRuntimeContract["buildLifecycleEntry"]>[0],
): ReturnType<SubagentRuntimeContract["buildLifecycleEntry"]> {
  return contract.buildLifecycleEntry(input);
}
