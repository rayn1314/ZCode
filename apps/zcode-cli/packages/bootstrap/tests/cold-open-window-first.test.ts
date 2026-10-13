// 冷打开「窗口优先 + 后台补全」（spec: apps/zcode-cli/packages/bootstrap/spec/cold-open-window-first.md）。
//
// 覆盖 acceptance A1–A6 的 gateway 侧契约：
// - A1 首帧不再等完整 activation：窗口态 snapshot 先到，openTiming 仍是 cold；
// - A2 窗口态是纯预览：行号用负数空间、firstRowId = 窗口首行（客户端 hasOlderRows=false），
//      更早历史一律等完整投影，窗口态不分页；
// - A3 补全后 rows/range 走投影全序行，内容与「一直 warm」口径一致；
// - A4 首帧 config 取持久化种子，补全后被 runtime 真值覆盖；
// - A5 后台 activation 失败时首屏仍在，错误进 onError，重试可再激活；
// - A6 既有语义：窗口覆盖整个会话 / legacy 排序 / 旧宿主无钩子一律走既有完整路径。
import { beforeEach, describe, expect, it } from "vitest";
import {
  createMessageId,
  createPartId,
  type MessageId,
  type MessageWithParts,
  type SessionId,
} from "@zcode/contracts";
import type { ConversationTopicFrame } from "@zcode/shared/zcode-protocol-v4";
import { conversationTopic } from "@zcode/shared/zcode-protocol-v4";
import { mergeColdConversationEvents } from "../src/zcode-protocol-v4/cold-event-merge.js";
import { ConversationTopicPublisher } from "../src/zcode-protocol-v4/conversation-topic-publisher.js";
import {
  ConversationV4Gateway,
  type ColdSessionResumeOutcome,
} from "../src/zcode-protocol-v4/index.js";
import type { SessionConfigSeed } from "../src/zcode-protocol-v4/product-projection.js";

const SESSION_ID = "sess_cold_window";

interface WindowHostStub {
  sessions: Set<string>;
  frames: ConversationTopicFrame[];
  errors: Array<{ scope: string; error: unknown }>;
  resumeCalls: number;
  /** 挂住 activation：首帧断言必须发生在它 resolve 之前。 */
  resumeGate: Promise<void>;
  releaseResume: () => void;
  resumeFails: number;
  /** 完整事件源（loadPersistedEvents）与窗口读共用同一份内存 transcript。 */
  messages: MessageWithParts[];
  synthesized: boolean;
  runtimeConfigSeed: SessionConfigSeed | null;
  persistedConfigSeed: SessionConfigSeed | null;
  hooks: { window: boolean; synth: boolean };
}

function userMessage(id: string, text: string, created: number): MessageWithParts {
  const messageID = createMessageId(id);
  return {
    info: {
      id: messageID,
      sessionID: SESSION_ID as SessionId,
      role: "user",
      time: { created },
      agent: "zcode-agent",
      tools: {},
    } as MessageWithParts["info"],
    parts: [
      {
        id: createPartId(`${id}-text`),
        sessionID: SESSION_ID as SessionId,
        messageID,
        type: "text",
        text,
        time: { start: created, end: created },
      },
    ],
  };
}

function assistantMessage(
  id: string,
  parentID: MessageId,
  text: string,
  created: number,
): MessageWithParts {
  const messageID = createMessageId(id);
  return {
    info: {
      id: messageID,
      sessionID: SESSION_ID as SessionId,
      role: "assistant",
      time: { created, completed: created },
      parentID,
      mode: "build",
      agent: "zcode-agent",
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    } as MessageWithParts["info"],
    parts: [
      {
        id: createPartId(`${id}-text`),
        sessionID: SESSION_ID as SessionId,
        messageID,
        type: "text",
        text,
        time: { start: created, end: created },
      },
    ],
  };
}

/** n 轮 user/assistant 交替的 transcript（sequence = 1-based 插入序）。 */
function transcript(turns: number): MessageWithParts[] {
  const messages: MessageWithParts[] = [];
  for (let index = 0; index < turns; index += 1) {
    const created = 1_000 + index * 10;
    const user = userMessage(`m-user-${index}`, `问题${index}`, created);
    const assistant = assistantMessage(
      `m-assistant-${index}`,
      user.info.id,
      `回答${index}`,
      created + 1,
    );
    messages.push(user, assistant);
  }
  return messages;
}

interface Slice {
  messages: MessageWithParts[];
  sequences: number[];
  totalCount: number;
  firstSequence: number | null;
  hasOlder: boolean;
  legacySequence: boolean;
}

/** 与 sqlite 实现同语义的内存切片：sequence 升序、尾部 limit 条、hasOlder 判据一致。 */
function sliceMessages(
  messages: MessageWithParts[],
  limit: number,
  legacy = false,
): Slice {
  const sequences = messages.map((_, index) => index);
  if (legacy) {
    return {
      messages: [],
      sequences: [],
      totalCount: messages.length,
      firstSequence: messages.length === 0 ? null : 0,
      hasOlder: false,
      legacySequence: true,
    };
  }
  const page = messages.slice(-limit);
  return {
    messages: page,
    sequences: sequences.slice(-limit),
    totalCount: messages.length,
    firstSequence: messages.length === 0 ? null : 0,
    hasOlder: messages.length > page.length,
    legacySequence: false,
  };
}

function makeHost(messages: MessageWithParts[], hooks = { window: true, synth: true }) {
  let releaseResume!: () => void;
  const resumeGate = new Promise<void>((resolve) => {
    releaseResume = resolve;
  });
  const host: WindowHostStub = {
    sessions: new Set(),
    frames: [],
    errors: [],
    resumeCalls: 0,
    resumeGate,
    releaseResume,
    resumeFails: 0,
    messages,
    synthesized: false,
    runtimeConfigSeed: {
      modelSelection: { providerId: "glm", modelId: "glm-runtime" },
      provider: "glm",
      model: "glm-runtime",
      thought: "deep",
      thoughtLevels: ["medium", "deep"],
      mode: "build",
    },
    persistedConfigSeed: {
      modelSelection: { providerId: "glm", modelId: "glm-persisted" },
      provider: "glm",
      model: "glm-persisted",
      thought: "medium",
      mode: "build",
    },
    hooks,
  };
  return host;
}

function makeGateway(host: WindowHostStub, options: { legacyWindow?: boolean } = {}) {
  return new ConversationV4Gateway(
    {
      sessionExists: (sessionId) => host.sessions.has(sessionId),
      emitWireFrame: (wire) => {
        host.frames.push(wire.frame as ConversationTopicFrame);
      },
      executeCommand: async () => undefined,
      resumePersistedSession: async (): Promise<ColdSessionResumeOutcome> => {
        host.resumeCalls += 1;
        await host.resumeGate;
        if (host.resumeFails > 0) {
          host.resumeFails -= 1;
          throw new Error("injected activation failure");
        }
        host.sessions.add(SESSION_ID);
        return { status: "resumed" };
      },
      loadPersistedEvents: async () => ({
        events: mergeColdConversationEvents({
          memoryEvents: [],
          messages: host.messages,
          sessionId: SESSION_ID,
        }).events,
        synthesized: host.synthesized,
        sourceEventSeq: 0,
      }),
      ...(host.hooks.window
        ? {
            readMessageWindow: async ({ limit }: { sessionId: string; limit: number }) => {
              await Promise.resolve();
              return sliceMessages(host.messages, limit, options.legacyWindow === true);
            },
          }
        : {}),
      ...(host.hooks.synth
        ? {
            synthesizeTranscriptEvents: async ({
              messages,
            }: {
              sessionId: string;
              messages: MessageWithParts[];
            }) =>
              mergeColdConversationEvents({
                memoryEvents: [],
                messages,
                sessionId: SESSION_ID,
              }).events,
          }
        : {}),
      getPersistedSessionConfigSeed: () => host.persistedConfigSeed,
      getSessionConfigSeed: () => host.runtimeConfigSeed,
      onError: (scope, error) => host.errors.push({ scope, error }),
    },
    { now: () => 1_700_000_999_000, createLogEpoch: () => "epoch-cold-window" },
  );
}

function subscribeParams() {
  return {
    topic: conversationTopic(SESSION_ID),
    connectionId: "conn-cold-window",
    clientMode: "desktop-continuous" as const,
  };
}

function snapshotOf(frame: ConversationTopicFrame | undefined) {
  if (frame?.payload.kind !== "snapshot") throw new Error("expected snapshot frame");
  return frame.payload.snapshot;
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timeout waiting for ${message}`);
}

/** 客户端 `hasOlderRows` 判据（conversationProjectionStore）。 */
function hasOlderRows(snapshot: ReturnType<typeof snapshotOf>): boolean {
  const first = snapshot.rows.window[0];
  if (!first || snapshot.rows.firstRowId === null) return false;
  return first.rowId > snapshot.rows.firstRowId;
}

describe("冷打开窗口优先（gateway 单元）", () => {
  let gateway: ConversationV4Gateway | undefined;

  beforeEach(() => {
    gateway?.dispose();
    gateway = undefined;
  });

  it("A1 首帧不等待 activation：窗口态 snapshot 先到，完整补全在后台", async () => {
    const host = makeHost(transcript(100));
    const result = await (gateway = makeGateway(host)).subscribe(subscribeParams());

    // 首帧到达时 activation 还没完成（resumeGate 未 release，record 不在册）。
    expect(host.resumeCalls).toBe(1);
    expect(host.sessions.has(SESSION_ID)).toBe(false);
    expect(result.ack.mode).toBe("snapshot");
    expect(result.ack.openTiming).toMatchObject({ sessionRuntimeState: "cold" });

    const snapshot = snapshotOf(result.initialFrame ?? undefined);
    // totalCount 取 store 口径（真实消息总数，不是窗口可见行数）。
    expect(snapshot.rows.totalCount).toBe(host.messages.length);
    // 窗口态行号是负数空间：与权威全序 rowId 不撞号，也是客户端识别窗口态的标记。
    expect(snapshot.rows.window.length).toBe(60);
    expect(snapshot.rows.window.every((row) => row.rowId < 0)).toBe(true);
    expect(snapshot.rows.window.map((row) => row.rowId)).toEqual(
      [...snapshot.rows.window.map((row) => row.rowId)].toSorted((a, b) => a - b),
    );
    // 纯预览不变式：firstRowId = 窗口首行 ⇒ 客户端 hasOlderRows 为 false。
    expect(snapshot.rows.firstRowId).toBe(snapshot.rows.window[0]!.rowId);
    expect(hasOlderRows(snapshot)).toBe(false);
    // 首帧 config 取持久化种子（runtime 真值还没就位）。
    expect(snapshot.config).toMatchObject({
      model: "glm-persisted",
      provider: "glm",
      thought: "medium",
    });

    host.releaseResume();
    await waitFor(() => host.frames.length > 0, "completion snapshot frame");
    expect(host.frames.at(-1)?.payload.kind).toBe("snapshot");
  });

  it("A2 窗口态不提供更早历史：rowsRange 等完整投影，窗口态行号在权威空间里取不到行", async () => {
    const host = makeHost(transcript(100));
    gateway = makeGateway(host);
    const result = await gateway.subscribe(subscribeParams());
    const windowSnapshot = snapshotOf(result.initialFrame ?? undefined);

    let settled = false;
    const pending = gateway
      .rowsRange({
        sessionId: SESSION_ID,
        beforeRowId: windowSnapshot.rows.window[0]!.rowId,
        limit: 60,
        clientMode: "desktop-continuous",
      })
      .then((response) => {
        settled = true;
        return response;
      });
    // activation 未完成时窗口态没有更早历史可给：查询挂在完整 READY 上，绝不返回临时行。
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);

    host.releaseResume();
    const response = await pending;
    expect(response.atLogEpoch).toBe(windowSnapshot.logEpoch);
    // 游标是窗口态负数行号，权威全序行都大于它 ⇒ 没有更早行：失败关闭为空页，
    // 而不是把窗口态行或错位历史混进来。客户端在窗口态本就不会发起这次查询
    // （hasOlderRows=false），翻转后也会按权威首行重新取。
    expect(response.rows).toEqual([]);
    expect(response.hasMore).toBe(false);
  });

  it("A3/A4 补全后原子替换为完整投影，config 换成 runtime 真值", async () => {
    const host = makeHost(transcript(100));
    gateway = makeGateway(host);
    const result = await gateway.subscribe(subscribeParams());
    const windowSnapshot = snapshotOf(result.initialFrame ?? undefined);
    const logEpoch = windowSnapshot.logEpoch;

    host.releaseResume();
    await waitFor(() => host.frames.length > 0, "completion snapshot frame");
    const complete = snapshotOf(host.frames.at(-1));

    // 全序口径：firstRowId = 1（不再是窗口态行号），logEpoch 不变（同一 publisher 实例）。
    expect(complete.rows.firstRowId).toBe(1);
    expect(complete.rows.window.every((row) => row.rowId > 0)).toBe(true);
    expect(complete.logEpoch).toBe(logEpoch);
    expect(complete.config).toMatchObject({
      model: "glm-runtime",
      thought: "deep",
      thoughtLevels: ["medium", "deep"],
    });
    // 完整态 rows/range 走投影切片：一路向上翻能到全局首行，且内容与该消息一致。
    const collectedTexts: string[] = [];
    let cursor = complete.rows.window[0]!.rowId;
    let reachedStart = false;
    for (let page = 0; page < 6; page += 1) {
      const response = await gateway.rowsRange({
        sessionId: SESSION_ID,
        beforeRowId: cursor,
        limit: 200,
        clientMode: "desktop-continuous",
      });
      expect(response.atLogEpoch).toBe(logEpoch);
      expect(response.rows.map((row) => row.rowId)).toEqual(
        [...response.rows.map((row) => row.rowId)].toSorted((a, b) => a - b),
      );
      if (response.rows.length === 0) {
        reachedStart = true;
        break;
      }
      collectedTexts.unshift(
        ...response.rows
          .filter((row) => row.kind === "userInput" || row.kind === "assistantText")
          .map((row) => ("text" in row ? row.text : "")),
      );
      cursor = response.rows[0]!.rowId;
      if (!response.hasMore) {
        reachedStart = true;
        break;
      }
    }
    expect(reachedStart).toBe(true);
    // 全序首行的行号是 1（不是窗口态行号），也就是完整投影而不是窗口子集。
    expect(cursor).toBe(1);
    expect(collectedTexts[0]).toBe("问题0");
  });

  it("A5 activation 失败：首屏保持可用，错误可见，重试可再次激活", async () => {
    const host = makeHost(transcript(100));
    host.resumeFails = 1;
    gateway = makeGateway(host);
    const result = await gateway.subscribe(subscribeParams());
    expect(snapshotOf(result.initialFrame ?? undefined).rows.window.length).toBeGreaterThan(0);

    host.releaseResume();
    await waitFor(
      () => host.errors.some((entry) => entry.scope === "v4.coldOpen.complete"),
      "cold complete failure reported",
    );
    // 失败后窗口投影仍可读：再订阅会重新走窗口路径并再次尝试激活。
    const retried = await gateway.subscribe(subscribeParams());
    expect(snapshotOf(retried.initialFrame ?? undefined).rows.window.length).toBeGreaterThan(0);
    expect(host.resumeCalls).toBe(2);
    await waitFor(() => host.sessions.has(SESSION_ID), "activation retried");
  });

  it("A6 窗口覆盖整个会话时走既有完整路径：首帧即完整投影 + runtime config", async () => {
    const host = makeHost(transcript(10));
    // 完整路径要等 activation 完成才出首帧：放开闸门。
    host.releaseResume();
    gateway = makeGateway(host);
    const result = await gateway.subscribe(subscribeParams());
    const snapshot = snapshotOf(result.initialFrame ?? undefined);

    expect(host.resumeCalls).toBe(1);
    expect(snapshot.rows.firstRowId).toBe(1);
    expect(snapshot.config).toMatchObject({ model: "glm-runtime", thought: "deep" });
  });

  it("A6 legacy 排序口径 / 旧宿主无钩子同样回退完整路径", async () => {
    const legacyHost = makeHost(transcript(100));
    legacyHost.releaseResume();
    gateway = makeGateway(legacyHost, { legacyWindow: true });
    const legacy = snapshotOf(
      (await gateway.subscribe(subscribeParams())).initialFrame ?? undefined,
    );
    expect(legacy.rows.firstRowId).toBe(1);
    expect(legacy.config).toMatchObject({ model: "glm-runtime" });

    gateway.dispose();
    const plainHost = makeHost(transcript(100), { window: false, synth: false });
    plainHost.releaseResume();
    gateway = makeGateway(plainHost);
    const plain = snapshotOf(
      (await gateway.subscribe(subscribeParams())).initialFrame ?? undefined,
    );
    expect(plain.rows.firstRowId).toBe(1);
    expect(plain.config).toMatchObject({ model: "glm-runtime" });
  });

  it("完整事件日志（synthesized=false）也不保留窗口投影：补全必须重放", async () => {
    const host = makeHost(transcript(100));
    host.synthesized = false;
    gateway = makeGateway(host);
    const result = await gateway.subscribe(subscribeParams());
    const windowSnapshot = snapshotOf(result.initialFrame ?? undefined);
    expect(windowSnapshot.rows.firstRowId).toBe(windowSnapshot.rows.window[0]!.rowId);
    expect(hasOlderRows(windowSnapshot)).toBe(false);

    host.releaseResume();
    await waitFor(() => host.frames.length > 0, "completion snapshot frame");
    // 早退分支必须被窗口态标记拦下：否则窗口投影会被当成健康 live publisher 永久保留。
    expect(snapshotOf(host.frames.at(-1)).rows.firstRowId).toBe(1);
  });
});

describe("窗口态 publisher 契约", () => {
  function makePublisher(messages: MessageWithParts[]) {
    const publisher = new ConversationTopicPublisher(SESSION_ID, "epoch-window", {
      now: () => 1_700_000_999_000,
    });
    publisher.rehydrate(
      mergeColdConversationEvents({ memoryEvents: [], messages, sessionId: SESSION_ID }).events,
    );
    return publisher;
  }

  it("窗口态 wire snapshot：行取窗口元信息、firstRowId = 实际下发窗口首行，完整态回到全序行", () => {
    const publisher = makePublisher(transcript(30));
    const projectionRows = publisher.getSnapshot().rows.window;
    const totalCount = 900;
    // 模拟 gateway 的改写：负数空间、升序、与投影局部行号无关。
    const windowRows = projectionRows.map((row, index) => ({
      ...row,
      rowId: -(projectionRows.length - index) * 100_000,
    }));
    publisher.markRowsIncomplete({ totalCount, rows: windowRows });
    expect(publisher.isRowsIncomplete()).toBe(true);

    const frame = publisher.subscribe({ connectionId: "c", deliveryProfile: "continuous" }).frame;
    if (frame?.payload.kind !== "snapshot") throw new Error("expected snapshot");
    const snapshot = frame.payload.snapshot;
    expect(snapshot.rows.totalCount).toBe(totalCount);
    expect(snapshot.rows.window.every((row) => row.rowId < 0)).toBe(true);
    // wire 截到尾部 60 行后，firstRowId 必须与截断后的首行同源，否则 hasOlderRows 会错误为真。
    const expectedFirst = snapshot.rows.window[0]!.rowId;
    expect(snapshot.rows.firstRowId).toBe(expectedFirst);
    expect(snapshot.rows.window[0]!.rowId > (snapshot.rows.firstRowId as number)).toBe(false);

    publisher.markRowsComplete();
    expect(publisher.isRowsIncomplete()).toBe(false);
    const complete = publisher.getSnapshot();
    expect(complete.rows.totalCount).toBe(projectionRows.length);
    expect(complete.rows.firstRowId).toBe(1);
  });
});
