// 冷打开首帧的 config 种子（spec: zcode-protocol-v4/../spec/cold-open-window-first.md §5）。
//
// 首帧不激活 runtime，因此拿不到 `getSessionConfigSeed` 的 runtime 真值；模型/模式只能来自
// 持久化事实：模型选型 entry（`runtime/model_selection`，写路径见 core
// `persistRuntimeModelSelection`）+ transcript 末条 assistant 的 mode。
// activation 完成后同一批字段会被 runtime 真值覆盖（`ProductProjection.seedConfig`
// 只跳过事件触碰过的字段，种子之间后者获胜），所以这里只要「取值正确、不伪造能力」。
import {
  SESSION_ENTRY_MODEL_SELECTION,
  type MessageWithParts,
  type ModelSelection,
  type SessionId,
} from "@zcode/contracts";
import type { SessionConfigSeed } from "../zcode-protocol-v4/product-projection.js";
import { cloneModelSelection } from "./fork-model-selection.js";
import { derivePersistedSessionMode } from "./server-operations.js";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";

export async function buildPersistedSessionConfigSeed(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
  messages: readonly MessageWithParts[],
): Promise<SessionConfigSeed | null> {
  const store = context.deps.sessionStore;
  if (!store?.sessionEntry) return null;
  // entry id 是 core 的持久化契约（`${sessionId}:runtime-model-selection`），命中主键 O(1)。
  const entry = await store.sessionEntry({
    sessionID: sessionId as SessionId,
    id: `${sessionId}:runtime-model-selection`,
    type: SESSION_ENTRY_MODEL_SELECTION,
  });
  const selection = entry?.data as ModelSelection | undefined;
  const mode = derivePersistedSessionMode(messages);
  if (!selection && !mode) return null;
  return {
    ...(selection
      ? {
          modelSelection: cloneModelSelection(selection),
          provider: selection.providerId,
          model: selection.modelId,
          thought: selection.options?.reasoningLevel ?? "",
        }
      : {}),
    // thoughtLevels 不在持久化事实里（属于当前 provider registry 的能力面，只有 app 实例
    // 能列举）。留空而不是猜：猜错会让首帧档位与 runtime 真值不一致，跳变更明显。
    ...(mode ? { mode, planEnabled: mode === "plan" } : {}),
  };
}
