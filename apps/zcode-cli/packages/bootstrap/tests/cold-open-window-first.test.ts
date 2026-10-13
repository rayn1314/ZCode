// 冷打开「窗口优先 + 后台补全」（spec: apps/zcode-cli/packages/bootstrap/spec/cold-open-window-first.md）。
//
// 覆盖 acceptance A1–A6 的 gateway 侧契约：
// - A1 首帧不再等完整 activation：窗口态 snapshot 先到，openTiming 仍是 cold；
// - A2 窗口态 rows/range 从 store 分页返回更早行，且能一路翻到会话开头；
// - A3 补全后 rows/range 走投影全序行，内容与「一直 warm」口径一致；
// - A4 首帧 config 取持久化种子，补全后被 runtime 真值覆盖；
// - A5 后台 activation 失败时首屏仍在，错误进 onError，重试可再激活；
// - A6 既有语义：窗口覆盖整个会话 / legacy 排序 / 旧宿主无钩子一律走既有完整路径。
import { beforeEach, describe, expect, it } from "vitest";
import {
  createMessageId,
  createPartId,
  type MessageWithParts,
  type SessionId,
} from "@zcode/contracts";
import type { ConversationTopicFrame } from "@zcode/shared/zcode-protocol-v4";
import { conversationTopic } from "@zcode/shared/zcode-protocol-v4";
import { mergeColdConversationEvents } from "../src/zcode-protocol-v4/cold-event-merge.js";
import { coldWindowFirstRowId } from "../src/zcode-protocol-v4/cold-window-rows.js";
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
  hooks: { window: boolean; page: boolean; synth: boolean };
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
  beforeSequence: number | undefined,
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
  const eligible = messages
    .map((message, index) => ({ message, sequence: sequences[index]! }))
    .filter((entry) => beforeSequence === undefined || entry.sequence < beforeSequence);
  const page = eligible.slice(-limit);
  return {
    messages: page.map((entry) => entry.message),
    sequences: page.map((entry) => entry.sequence),
    totalCount: messages.length,
    firstSequence: messages.length === 0 ? null : 0,
    hasOlder: eligible.length > page.length,
    legacySequence: false,
  };
}

function makeHost(messages: MessageWithParts[], hooks = { window: true, page: true, synth: true }) {
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
              return sliceMessages(host.messages, undefined, limit, options.legacyWindow === true);
            },
          }
        : {}),
      ...(host.hooks.page
        ? {
            readMessagePageBefore: async ({
              beforeSequence,
              limit,
            }: {
              sessionId: string;
              beforeSequence?: number;
              limit: number;
            }) => sliceMessages(host.messages, beforeSequence, limit),
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
    expect(snapshot.rows.totalCount).toBe(host.messages.length);
    const firstRowId = snapshot.rows.firstRowId;
    expect(firstRowId).not.toBeNull();
    // 窗口态哨兵 < 窗口首行 ⇒ 客户端判定「还有更早行」。
    expect(firstRowId as number).toBeLessThan(snapshot.rows.window[0]!.rowId);
    expect(firstRowId).toBe(coldWindowFirstRowId(host.messages.length));
    // wire 只发尾部窗口。
    expect(snapshot.rows.window.length).toBe(60);
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

  it("A3/A4 补全后原子替换为完整投影，config 换成 runtime 真值", async () => {
    const host = makeHost(transcript(100));
    gateway = makeGateway(host);
    const result = await gateway.subscribe(subscribeParams());
    const windowSnapshot = snapshotOf(result.initialFrame ?? undefined);
    const logEpoch = windowSnapshot.logEpoch;

    host.releaseResume();
    await waitFor(() => host.frames.length > 0, "completion snapshot frame");
    const complete = snapshotOf(host.frames.at(-1));

    // 全序口径：firstRowId = 1（不再是窗口态哨兵），logEpoch 不变（同一 publisher 实例）。
    expect(complete.rows.firstRowId).toBe(1);
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
    // 全序首行的行号是 1（不是窗口态哨兵），也就是完整投影而不是窗口子集。
    expect(cursor).toBe(1);
    expect(collectedTexts[0]).toBe("问题0");
  });

  it("A2 窗口态 rows/range 从 store 分页：逐页更早、无缝无重叠、翻到会话开头即到顶", async () => {
    const host = makeHost(transcript(100));
    gateway = makeGateway(host);
    const result = await gateway.subscribe(subscribeParams());
    const windowSnapshot = snapshotOf(result.initialFrame ?? undefined);
    const totalCount = windowSnapshot.rows.totalCount;

    let cursor = windowSnapshot.rows.window[0]!.rowId;
    const pages: Array<{ ids: number[]; texts: string[] }> = [];
    for (let page = 0; page < 4; page += 1) {
      const response = await gateway.rowsRange({
        sessionId: SESSION_ID,
        beforeRowId: cursor,
        limit: 60,
        clientMode: "desktop-continuous",
      });
      // 窗口态翻页由 store 供给：全部行号都严格小于窗口首行。
      expect(response.rows.every((row) => row.rowId < cursor)).toBe(true);
      expect(response.rows.map((row) => row.rowId)).toEqual(
        [...response.rows.map((row) => row.rowId)].toSorted((a, b) => a - b),
      );
      expect(response.atLogEpoch).toBe(windowSnapshot.logEpoch);
      pages.push({
        ids: response.rows.map((row) => row.rowId),
        texts: response.rows
          .filter((row) => row.kind === "userInput" || row.kind === "assistantText")
          .map((row) => ("text" in row ? row.text : "")),
      });
      if (response.rows.length === 0) break;
      cursor = response.rows[0]!.rowId;
      if (!response.hasMore) break;
    }
    // 页是按「更早方向」取回的：拼装时倒序页序，而不是倒序每页内部的行。
    const collected = pages.toReversed().flatMap((page) => page.ids);
    const texts = pages.toReversed().flatMap((page) => page.texts);
    // 会话开头那一段：最旧行的行号正是全序首行（哨兵），客户端据此停手。
    expect(cursor).toBe(coldWindowFirstRowId(totalCount));
    expect(collected).toEqual([...collected].toSorted((a, b) => a - b));
    expect(texts[0]).toBe("问题0");
    // 每行都落在窗口态行号空间内（负数，与窗口行 1..k 不冲突）。
    expect(collected.every((rowId) => rowId < 0)).toBe(true);
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
    const plainHost = makeHost(transcript(100), { window: false, page: false, synth: false });
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
    expect(snapshotOf(result.initialFrame ?? undefined).rows.firstRowId).not.toBe(1);

    host.releaseResume();
    await waitFor(() => host.frames.length > 0, "completion snapshot frame");
    // 早退分支必须被窗口态标记拦下：否则窗口投影会被当成健康 live publisher 永久保留。
    expect(snapshotOf(host.frames.at(-1)).rows.firstRowId).toBe(1);
  });

  it("窗口态 rows/range 在 store 分页钩子缺席时失败关闭为可诊断空页", async () => {
    // 合成钩子在位（窗口态成立），但分页钩子缺席：翻页失败关闭，不偷偷回退全量。
    const host = makeHost(transcript(100), { window: true, page: false, synth: true });
    gateway = makeGateway(host);
    const result = await gateway.subscribe(subscribeParams());
    const snapshot = snapshotOf(result.initialFrame ?? undefined);
    const response = await gateway.rowsRange({
      sessionId: SESSION_ID,
      beforeRowId: snapshot.rows.window[0]!.rowId,
      limit: 60,
      clientMode: "desktop-continuous",
    });
    expect(response.rows).toEqual([]);
    expect(response.hasMore).toBe(false);
    host.releaseResume();
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

  it("窗口态 wire snapshot 的 totalCount/firstRowId 取 store 口径，完整态回到全序行", () => {
    const publisher = makePublisher(transcript(5));
    const fullRowCount = publisher.getSnapshot().rows.window.length;
    const totalCount = 900;
    publisher.markRowsIncomplete({
      totalCount,
      firstRowId: coldWindowFirstRowId(totalCount),
    });
    expect(publisher.isRowsIncomplete()).toBe(true);

    const frame = publisher.subscribe({ connectionId: "c", deliveryProfile: "continuous" }).frame;
    if (frame?.payload.kind !== "snapshot") throw new Error("expected snapshot");
    expect(frame.payload.snapshot.rows.totalCount).toBe(totalCount);
    expect(frame.payload.snapshot.rows.firstRowId).toBe(coldWindowFirstRowId(totalCount));
    // 窗口首行（局部行号）仍大于哨兵 ⇒ hasOlderRows 判定为真。
    expect(frame.payload.snapshot.rows.window[0]!.rowId).toBeGreaterThan(
      frame.payload.snapshot.rows.firstRowId as number,
    );

    publisher.markRowsComplete();
    expect(publisher.isRowsIncomplete()).toBe(false);
    const complete = publisher.getSnapshot();
    expect(complete.rows.totalCount).toBe(fullRowCount);
    expect(complete.rows.firstRowId).toBe(1);
  });

  it("readRowsRange 窗口态委托 store 分页，完整态走投影切片且不调用注入回调", async () => {
    const publisher = makePublisher(transcript(5));
    let delegated = 0;
    const readOlderRows = async (params: { beforeRowId: number; limit: number }) => {
      delegated += 1;
      return {
        rows: [],
        atSeq: 7,
        atRevision: 0,
        atLogEpoch: "epoch-window",
        hasMore: params.limit > 0,
      };
    };

    // 完整态：注入回调必须被忽略。
    const projection = await publisher.readRowsRange(
      { beforeRowId: 1_000, limit: 60 },
      "continuous",
      readOlderRows,
    );
    expect(delegated).toBe(0);
    expect(projection.rows.length).toBeGreaterThan(0);
    expect(projection.atLogEpoch).toBe("epoch-window");

    publisher.markRowsIncomplete({ totalCount: 50, firstRowId: coldWindowFirstRowId(50) });
    const delegatedResult = await publisher.readRowsRange(
      { beforeRowId: publisher.getSnapshot().rows.window[0]!.rowId, limit: 60 },
      "continuous",
      readOlderRows,
    );
    expect(delegated).toBe(1);
    expect(delegatedResult.atSeq).toBe(7);
    expect(delegatedResult.hasMore).toBe(true);
  });
});
