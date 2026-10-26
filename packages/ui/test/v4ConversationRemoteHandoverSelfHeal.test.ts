// 远程 workspace 断开重连后的连接换代窗口，点击历史会话必须自愈而不是弹红字。
//
// 线上复现时序（2026-10-27 dev 日志 00:29:44-45）：
//   00:29:44.876 用户点开会话 → store connect started
//   00:29:45.043 host: detached service port（设置页重连触发旧 remote session dispose）
//   00:29:45.045 host: window Host topology, reason=remote-session-disposed
//   00:29:45.162 renderer: subscribe failed errorMessage=ZCODE_REMOTE_WORKSPACE_DISCONNECTED
//   00:29:45.168 store connect failed → status="error" → SessionPane 红色错误面板
//
// 修复前缺陷：connect() 的 catch 只认 runtime 换代类瞬态错误（isRuntimeRecycleError），
// 远程连接换代类失败（断连代理 / scope 已 closed / 握手未完成）一律定格 error，
// 用户必须等新 session services 挂载后再点一次（activateRemoteService → replace →
// transportReplaced 才触发重连）。与既有先例同族：按 ID 判定没有「正在来」状态 → 修法是
// 有界等待（46c578c5 host attachment 等待、runtime recycle 退避）。
//
// 边界约束：设备真离线不能被无限等待掩盖——退避额度耗尽仍落 error，lastError 保留
// 真实错误串；且设备离线时 remoteAvailable=false，SessionPane 的 errored 分支本就不渲染。
import { Emitter } from "@zcode/rpc";
import type { ConversationTopicWireFrame } from "@zcode/shared/zcode-protocol-v4";
import {
  createZCodeAgentConnectionScope,
  readTrustedZCodeAgentV4Connection,
  type IZCodeAgentService,
} from "@zcode/services";
import { describe, expect, it, vi } from "vitest";
import { createAgentConversationTransport } from "@/v4/agentConversationTransport.js";
import { ConversationProjectionStore } from "@/v4/conversationProjectionStore.js";
import { ReplaceableConversationTransport } from "@/v4/replaceableConversationTransport.js";

const TOPIC = "conversation/s1";
const WORKSPACE_PATH = "/repo";

/** 设置页重连换代窗口里旧 remote session dispose 时，session.dispose(reconnectedError) 的真实文案。 */
const REMOTE_DISCONNECTED = "ZCODE_REMOTE_WORKSPACE_DISCONNECTED";

/** connectionScope dispose 后所有 RPC fail-fast 的真实文案（zcodeAgentConnectionScope assertOpen）。 */
const CONNECTION_CLOSED = "fault.connection.closed";

/** 与实现的瞬态重试延迟表长度一致（250/1000/3000ms）。 */
const TRANSIENT_RETRY_ATTEMPTS = 3;

function setupBase() {
  const conversationFrames = new Emitter<ConversationTopicWireFrame>();
  const runtimeRestarts = new Emitter<{ workspaceKey: string }>();
  const nextSerialByConnection = new Map<string, number>();
  const nextId = (params: unknown) => {
    const connection = readTrustedZCodeAgentV4Connection(params);
    if (!connection) throw new Error("missing trusted connection");
    const serial = (nextSerialByConnection.get(connection.connectionId) ?? 0) + 1;
    nextSerialByConnection.set(connection.connectionId, serial);
    return `sub-${connection.connectionId}-${serial}`;
  };
  /** 每次 subscribe 依次消费一个错误；用尽后正常 ACK。 */
  const pendingFailures: Error[] = [];
  const mocks = {
    helloConversationV4: vi.fn(),
    initializeConversationV4: vi.fn(),
    subscribeConversationV4: vi.fn(async (params: unknown) => {
      const failure = pendingFailures.shift();
      if (failure) throw failure;
      return {
        ack: {
          subscriptionId: nextId(params),
          mode: "snapshot" as const,
          logEpoch: "epoch-1",
        },
      };
    }),
    unsubscribeConversationV4: vi.fn(async () => {}),
    resyncConversationV4: vi.fn(async (params: { subscriptionId: string }) => ({
      ack: {
        subscriptionId: params.subscriptionId,
        mode: "resume" as const,
        logEpoch: "epoch-1",
      },
    })),
    sendConversationCommandV4: vi.fn(async (params: { envelope: { commandId: string } }) => ({
      commandId: params.envelope.commandId,
      status: "accepted" as const,
      revisionAtDecision: 1,
    })),
    onDynamicConversationFrame: vi.fn(() => conversationFrames.event),
    onAgentRuntimeRestarted: vi.fn((listener: (event: { workspaceKey: string }) => void) =>
      runtimeRestarts.event(listener),
    ),
    setConnectionFlowStateV4: vi.fn(async () => {}),
  };
  return {
    base: mocks as unknown as IZCodeAgentService,
    mocks,
    pendingFailures,
  };
}

describe("conversation projection 在远程 workspace 连接换代窗口自愈", () => {
  it.each([REMOTE_DISCONNECTED, CONNECTION_CLOSED, "fault.connection.handshakeRequired"] as const)(
    "%s 的冷订阅失败不定格 error，有界退避后自动重订",
    async (errorMessage) => {
      vi.useFakeTimers();
      try {
        const { base, mocks, pendingFailures } = setupBase();
        pendingFailures.push(new Error(errorMessage));
        const scope = createZCodeAgentConnectionScope(base, {
          connectionId: "conn-handover",
          clientMode: "desktop-continuous",
        });
        const transport = createAgentConversationTransport(scope.service, {
          workspacePath: WORKSPACE_PATH,
        });
        const store = new ConversationProjectionStore(TOPIC, transport);

        await store.connect();
        // 修复前：这里已是 status="error"，面板从此只能靠用户再点一次。
        expect(store.getState().status).toBe("connecting");
        expect(mocks.subscribeConversationV4).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1_000);
        expect(mocks.subscribeConversationV4).toHaveBeenCalledTimes(2);
        expect(store.getState().status).toBe("live");
        expect(store.getState().lastError).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("换代错误反复失败耗尽退避后落 error，lastError 保留真实错误串", async () => {
    vi.useFakeTimers();
    try {
      const { base, mocks, pendingFailures } = setupBase();
      for (let i = 0; i < TRANSIENT_RETRY_ATTEMPTS + 1; i += 1) {
        pendingFailures.push(new Error(REMOTE_DISCONNECTED));
      }
      const scope = createZCodeAgentConnectionScope(base, {
        connectionId: "conn-exhausted",
        clientMode: "desktop-continuous",
      });
      const transport = createAgentConversationTransport(scope.service, {
        workspacePath: WORKSPACE_PATH,
      });
      const store = new ConversationProjectionStore(TOPIC, transport);

      await vi.advanceTimersByTimeAsync(0);
      await store.connect();
      await vi.advanceTimersByTimeAsync(30_000);

      expect(store.getState().status).toBe("error");
      expect(store.getState().lastError).toContain(REMOTE_DISCONNECTED);
      expect(mocks.subscribeConversationV4.mock.calls.length).toBeLessThanOrEqual(
        1 + TRANSIENT_RETRY_ATTEMPTS,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("退避等待期间 proxy 换代立即重订，遗留 timer 不产生重复订阅", async () => {
    vi.useFakeTimers();
    try {
      const { base, mocks, pendingFailures } = setupBase();
      pendingFailures.push(new Error(REMOTE_DISCONNECTED));
      const scope = createZCodeAgentConnectionScope(base, {
        connectionId: "conn-handover-replace",
        clientMode: "desktop-continuous",
      });
      const replaceable = new ReplaceableConversationTransport(
        createAgentConversationTransport(scope.service, { workspacePath: WORKSPACE_PATH }),
      );
      const store = new ConversationProjectionStore(TOPIC, replaceable);

      await store.connect();
      expect(store.getState().status).toBe("connecting");

      // 新 session services 挂载：activateRemoteService() → replace()。
      const nextScope = createZCodeAgentConnectionScope(base, {
        connectionId: "conn-handover-replace-2",
        clientMode: "desktop-continuous",
      });
      replaceable.replace(
        createAgentConversationTransport(nextScope.service, { workspacePath: WORKSPACE_PATH }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(store.getState().status).toBe("live");
      expect(mocks.subscribeConversationV4).toHaveBeenCalledTimes(2);

      // 退避 timer 到期时代际已推进，不得再开第二条订阅。
      await vi.advanceTimersByTimeAsync(30_000);
      expect(mocks.subscribeConversationV4).toHaveBeenCalledTimes(2);
      expect(store.getState().status).toBe("live");
    } finally {
      vi.useRealTimers();
    }
  });
});
