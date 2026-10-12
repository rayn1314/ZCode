import { AgentRuntime } from "../src/runtime.js";
import type { AgentRuntimeConfig, AgentRuntimeDeps } from "../src/runtime/types.js";
import type { SubagentChildSessionHost } from "../src/subagent/child-session-host.js";
import { createTestModelSelection } from "./test-model-selection.js";
import { createTestModelFactory } from "./test-runtime-model.js";

type TestRuntimeConfig = Omit<AgentRuntimeConfig, "modelSelection"> &
  Partial<Pick<AgentRuntimeConfig, "modelSelection">> & {
    /** 测试模型的能力上限，不进入 Selection 或生产 Runtime Config。 */
    maxOutputTokens?: number;
  };
type TestRuntimeDeps = Omit<AgentRuntimeDeps, "modelFactory"> &
  Partial<Pick<AgentRuntimeDeps, "modelFactory">>;

/**
 * Agent 派发需要的子会话构造端口。
 *
 * 上游的 subagent 派发在 core 内部 `new AgentRuntime(...)` 直接造子会话；本 fork 把「构造一条
 * 子会话」抽成由 bootstrap 提供的 `SubagentChildSessionHost`（spec
 * `subagent-session-as-first-class.md` D1/S1b）：core 只交出父语境快照（`bundle.runtimeConfig`）
 * 与父作用域活端口（`bundle.deps`），record 登记、常驻与协议可见性归 bootstrap。core 低层测试
 * 没有那一层，所以必须在这里补一个等价 host——否则任何 Agent 派发都会失败于
 * 「Subagent dispatch requires the child session construction host」，而上游用例断言的
 * 都是派发后的行为，并不关心构造权在谁手里。
 *
 * D8（结构性防套娃）：子会话**不**借出 host，套娃派发照旧在 core 内显式失败。
 */
function createTestSubagentChildHost(parentDeps: TestRuntimeDeps): SubagentChildSessionHost {
  return {
    async createChildSession(bundle) {
      return new AgentRuntime(
        bundle.childSessionId,
        { ...bundle.runtimeConfig } as AgentRuntimeConfig,
        {
          // 借父级装配事实（IO / 存储 / 产物适配器实例）：与 bootstrap 借父 App 是同一语义，
          // 重建会开出第二份 artifact store 并脱离父会话的资源追踪。
          eventStore: parentDeps.eventStore,
          sessionStore: parentDeps.sessionStore,
          executionPort: parentDeps.executionPort,
          fileSystemPort: parentDeps.fileSystemPort,
          httpClientPort: parentDeps.httpClientPort,
          imageProcessorPort: parentDeps.imageProcessorPort,
          pdfDocumentPort: parentDeps.pdfDocumentPort,
          artifactStore: parentDeps.artifactStore,
          appVersion: parentDeps.appVersion,
          logger: parentDeps.logger,
          // core 派发时算好的父作用域活端口（子会话专用实例）覆盖上述借用项。
          ...bundle.deps,
          subagentChildHost: undefined,
        } as AgentRuntimeDeps,
      );
    },
  };
}

/**
 * 低层 Runtime 测试也显式经过 ModelFactory/ModelSelection 契约。
 * 与具体模型无关的测试由该 fixture 注入不可联网的测试 Model，不在生产 Runtime 制造 sentinel。
 */
export function createTestAgentRuntime(
  sessionId: ConstructorParameters<typeof AgentRuntime>[0],
  config: TestRuntimeConfig,
  deps: TestRuntimeDeps,
): AgentRuntime {
  const { maxOutputTokens, ...runtimeConfig } = config;
  const modelSelection =
    runtimeConfig.modelSelection ?? createTestModelSelection("test/default-runtime-model");
  const modelAdapter = deps.modelAdapter;
  const baseModelFactory =
    deps.modelFactory ??
    (modelAdapter
      ? createTestModelFactory({
          generateText: (request) => modelAdapter.generateText(request as never),
          ...(modelAdapter.streamText
            ? { streamText: (request) => modelAdapter.streamText!(request as never) }
            : {}),
        })
      : createTestModelFactory({}));
  const modelFactory =
    maxOutputTokens === undefined
      ? baseModelFactory
      : (input: Parameters<typeof baseModelFactory>[0]) => {
          const wrap = (
            model: ReturnType<typeof baseModelFactory>,
          ): ReturnType<typeof baseModelFactory> =>
            Object.freeze({
              ...model,
              optionSpecs: Object.freeze({
                ...model.optionSpecs,
                maxOutputTokens: Object.freeze({ max: maxOutputTokens }),
              }),
              bind(options) {
                return wrap(model.bind(options));
              },
            });
          return wrap(baseModelFactory(input));
        };
  return new AgentRuntime(
    sessionId,
    { ...runtimeConfig, modelSelection },
    {
      ...deps,
      modelFactory,
      subagentChildHost: deps.subagentChildHost ?? createTestSubagentChildHost(deps),
    },
  );
}
