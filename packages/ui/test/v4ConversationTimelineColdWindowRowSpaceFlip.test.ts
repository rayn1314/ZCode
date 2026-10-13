// 冷打开行身份空间翻转（spec: apps/zcode-cli/packages/bootstrap/spec/cold-open-window-first.md §A/§B）：
// 窗口态首帧的行号在负数空间（纯预览），补全 snapshot 整份换成权威全序行。同一个会话内
// 行身份空间翻转时，虚拟列表必须整份作废旧空间的派生状态（测高缓存 / prepend 锚点 /
// virtualizer measurements），再按「视口顶部所在 turn 的稳定 key」重锚定：
//   scrollTop = 新 measurement.start − 翻转前视口内偏移
// 回归表现：沿用了窗口态的行起点做 prepend/测高补偿，用户上翻几下后视口突然跳到很上面。
//
// 器具复制自 v4ConversationTimelineScrollMemory.test.ts（最小 DOM + mock virtualizer）。

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TID_V4_TIMELINE, TID_V4_TIMELINE_BOTTOM } from "@zcode/shared";
import type { ConversationRow, UserInputRow } from "@zcode/shared/zcode-protocol-v4";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { clearChatSessionScrollMemoryForTest } from "@/lib/chatSessionScrollMemory.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import { ConversationTimeline } from "@/v4/ConversationTimeline.js";

const layout = vi.hoisted(() => ({ clientHeight: 300, scrollHeight: 1200 }));
const virtualizer = vi.hoisted(() => ({
  getVirtualItemForOffset: vi.fn(),
  getTotalSize: () => layout.scrollHeight,
  getVirtualItems: () => [],
  measurementsCache: [] as Array<{
    end: number;
    index: number;
    key: string;
    lane: number;
    size: number;
    start: number;
  }>,
  measure: vi.fn(),
  measureElement: vi.fn(),
  scrollOffset: null as number | null,
  scrollRect: null as { height: number } | null,
  scrollToIndex: vi.fn(),
  shouldAdjustScrollPositionOnItemSizeChange: null as
    | null
    | ((item: { end: number; start: number }) => boolean),
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: () => virtualizer,
}));

vi.mock("@/v4/ConversationTurnGroup.js", async () => {
  const React = await import("react");
  return {
    ConversationTurnGroup: () => React.createElement("div"),
  };
});

vi.mock("@/v4/ConversationTurnNavigator.js", () => ({
  ConversationTurnNavigator: () => null,
}));

vi.mock("@/v4/useConversationTimelineFind.js", () => ({
  useConversationTimelineFind: () => undefined,
}));

type TestEventHandler = (event: Record<string, unknown>) => void;
type TestElement = Element & {
  __attrs: Map<string, string>;
  __listeners: Map<string, TestEventHandler[]>;
  childNodes: TestElement[];
  parentNode: TestElement | null;
  scrollTop: number;
};

let nextFrameId = 1;
const animationFrames = new Map<number, FrameRequestCallback>();
const scheduledMicrotasks: Array<() => void> = [];
const nativeQueueMicrotask = globalThis.queueMicrotask;
let mountedRoot: Root | null = null;

function createMinimalElement(ownerDocument: Document, tagName = "div"): TestElement {
  let scrollTop = 0;
  const element = {
    __attrs: new Map<string, string>(),
    __listeners: new Map<string, TestEventHandler[]>(),
    addEventListener: (type: string, handler: TestEventHandler) => {
      element.__listeners.set(type, [...(element.__listeners.get(type) ?? []), handler]);
    },
    appendChild: (child: TestElement) => {
      child.parentNode = element as unknown as TestElement;
      element.childNodes.push(child);
      return child;
    },
    childNodes: [] as TestElement[],
    dispatchEvent: (event: Event) => {
      const forwardedEvent = {
        bubbles: event.bubbles,
        cancelBubble: event.cancelBubble,
        currentTarget: element,
        defaultPrevented: event.defaultPrevented,
        preventDefault: () => event.preventDefault(),
        stopPropagation: () => event.stopPropagation(),
        target: element,
        timeStamp: event.timeStamp,
        type: event.type,
      };
      for (const handler of element.__listeners.get(event.type) ?? []) {
        handler(forwardedEvent);
      }
      return !event.defaultPrevented;
    },
    getBoundingClientRect: () => ({
      bottom: layout.clientHeight,
      height: layout.clientHeight,
      left: 0,
      right: 800,
      top: 0,
      width: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
    getAttribute: (name: string) => element.__attrs.get(name) ?? null,
    insertBefore: (child: TestElement, beforeChild?: TestElement | null) => {
      child.parentNode = element as unknown as TestElement;
      const index = beforeChild ? element.childNodes.indexOf(beforeChild) : -1;
      if (index >= 0) element.childNodes.splice(index, 0, child);
      else element.childNodes.push(child);
      return child;
    },
    nodeName: tagName.toUpperCase(),
    nodeType: 1,
    ownerDocument,
    parentNode: null as TestElement | null,
    removeAttribute: (name: string) => element.__attrs.delete(name),
    removeChild: (child: TestElement) => {
      element.childNodes = element.childNodes.filter((item) => item !== child);
      child.parentNode = null;
      return child;
    },
    removeEventListener: (type: string, handler: TestEventHandler) => {
      element.__listeners.set(
        type,
        (element.__listeners.get(type) ?? []).filter((item) => item !== handler),
      );
    },
    querySelectorAll: () => [],
    setAttribute: (name: string, value: string) => {
      element.__attrs.set(name, String(value));
    },
    style: {},
    tagName: tagName.toUpperCase(),
  };
  Object.defineProperties(element, {
    clientHeight: { get: () => layout.clientHeight },
    scrollHeight: { get: () => layout.scrollHeight },
    scrollTop: {
      get: () => scrollTop,
      set: (value: number) => {
        // 与浏览器一致：赋值按当前内容高度钳制。
        scrollTop = Math.min(
          Math.max(Number(value) || 0, 0),
          Math.max(layout.scrollHeight - layout.clientHeight, 0),
        );
      },
    },
  });
  return element as unknown as TestElement;
}

function installMinimalDom(): TestElement {
  const documentMock = {
    addEventListener: () => {},
    createElement: (tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createElementNS: (_namespace: string, tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createTextNode: (nodeValue: string) => ({
      nodeType: 3,
      nodeValue,
      ownerDocument: documentMock,
      parentNode: null,
    }),
    nodeType: 9,
    removeEventListener: () => {},
  } as unknown as Document & { defaultView?: unknown };
  const windowMock = {
    addEventListener: () => {},
    cancelAnimationFrame: (frameId: number) => animationFrames.delete(frameId),
    document: documentMock,
    HTMLElement: function HTMLElement() {},
    HTMLIFrameElement: function HTMLIFrameElement() {},
    Node: function Node() {},
    queueMicrotask: (callback: () => void) => scheduledMicrotasks.push(callback),
    removeEventListener: () => {},
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const frameId = nextFrameId;
      nextFrameId += 1;
      animationFrames.set(frameId, callback);
      return frameId;
    },
  };
  documentMock.defaultView = windowMock;
  Object.assign(globalThis, {
    document: documentMock,
    HTMLElement: windowMock.HTMLElement,
    HTMLIFrameElement: windowMock.HTMLIFrameElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    Node: windowMock.Node,
    queueMicrotask: windowMock.queueMicrotask,
    window: windowMock,
  });
  return createMinimalElement(documentMock, "div");
}

function findByTestId(node: TestElement, testId: string): TestElement | null {
  if (node.getAttribute("data-testid") === testId) return node;
  for (const child of node.childNodes) {
    if (child.nodeType !== 1) continue;
    const match = findByTestId(child, testId);
    if (match) return match;
  }
  return null;
}

function flushAnimationFrame(): void {
  const frameIds = [...animationFrames.keys()];
  for (const frameId of frameIds) {
    const callback = animationFrames.get(frameId);
    if (!callback) continue;
    animationFrames.delete(frameId);
    callback(0);
  }
}

function flushScheduledMicrotasks(): void {
  while (scheduledMicrotasks.length > 0) {
    scheduledMicrotasks.shift()?.();
  }
}

function dispatchScroll(element: TestElement): void {
  element.dispatchEvent(new Event("scroll"));
}

/** React 把 wheel 委托在根容器上：沿父链把捕获/冒泡监听都喂一遍，等价真实捕获。 */
function dispatchWheel(element: TestElement, deltaY: number): void {
  const event = {
    bubbles: true,
    cancelBubble: false,
    currentTarget: element,
    defaultPrevented: false,
    deltaMode: 0,
    deltaX: 0,
    deltaY,
    preventDefault: () => {},
    stopPropagation: () => {},
    target: element,
    timeStamp: Date.now(),
    type: "wheel",
  };
  const path: TestElement[] = [];
  let current: TestElement | null = element;
  while (current) {
    path.push(current);
    current = current.parentNode;
  }
  for (const currentTarget of path.reverse()) {
    event.currentTarget = currentTarget;
    for (const handler of currentTarget.__listeners.get("wheel") ?? []) handler(event);
  }
  for (const currentTarget of path) {
    event.currentTarget = currentTarget;
    for (const handler of currentTarget.__listeners.get("wheel") ?? []) handler(event);
  }
}

function userInputRow(rowId: number): UserInputRow {
  return {
    rowId,
    turnId: `turn-${rowId}`,
    createdAt: 1_700_000_000_000 + rowId,
    createdAtSeq: rowId,
    kind: "userInput",
    origin: "realUser",
    text: `message ${rowId}`,
    attachments: [],
  };
}

const rowContext: ConversationRowRenderContext = {
  codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
  sessionId: "session-1",
  theme: "system",
  workspacePath: "/workspace",
};

function renderTimeline(
  root: Root,
  sessionKey: string,
  scrollMemoryKey: string | null,
  rows: readonly ConversationRow[],
  options: { canLoadOlder?: boolean; totalCount?: number } = {},
): void {
  root.render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ConversationTimeline, {
        canLoadOlder: options.canLoadOlder,
        rows,
        totalCount: options.totalCount ?? rows.length,
        sessionKey,
        scrollMemoryKey,
        rowContext,
      }),
    ),
  );
}

const KEY = "workspace::pane:a::session:cold";

/** 尾部窗口的 turn key 在翻转前后必须稳定（真实场景：同一批 turn，只有行号空间换了）。 */
function turnRow(rowId: number, turnId: string): UserInputRow {
  return { ...userInputRow(1), rowId, turnId, createdAtSeq: rowId, text: `message ${rowId}` };
}

/** 窗口态：纯预览的负数行号空间（首行为负数即窗口态标记）。 */
const ROWS_WINDOW = [
  turnRow(-900_000, "turn-w1"),
  turnRow(-800_000, "turn-w2"),
  turnRow(-700_000, "turn-w3"),
];
/** 权威态：同一批 turn 换成全序行号，前面还多了更早的 turn（起点因此整体下移）。 */
const ROWS_AUTHORITATIVE = [
  turnRow(11, "turn-e1"),
  turnRow(12, "turn-e2"),
  turnRow(101, "turn-w1"),
  turnRow(102, "turn-w2"),
  turnRow(103, "turn-w3"),
];

function measurement(key: string, index: number, start: number) {
  return { end: start + 72, index, key, lane: 0, size: 72, start };
}

beforeEach(() => {
  clearChatSessionScrollMemoryForTest();
  layout.clientHeight = 300;
  layout.scrollHeight = 1200;
  nextFrameId = 1;
  animationFrames.clear();
  scheduledMicrotasks.length = 0;
  virtualizer.getVirtualItemForOffset.mockReset();
  virtualizer.measurementsCache = [];
  virtualizer.measure.mockClear();
});

afterEach(() => {
  act(() => {
    flushScheduledMicrotasks();
    mountedRoot?.unmount();
    flushScheduledMicrotasks();
  });
  mountedRoot = null;
  animationFrames.clear();
  scheduledMicrotasks.length = 0;
  globalThis.queueMicrotask = nativeQueueMicrotask;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
});

describe("冷打开行身份空间翻转（窗口态 → 权威态）", () => {
  /** 打开窗口态会话，并让用户滚出一个离底阅读位置（视口顶部落在 turn-w2 内）。 */
  function mountWindowStateWithUserScroll() {
    const container = installMinimalDom();
    mountedRoot = createRoot(container);
    act(() => renderTimeline(mountedRoot!, "session-cold", KEY, ROWS_WINDOW));
    const timeline = findByTestId(container, TID_V4_TIMELINE)!;
    act(() => {
      flushAnimationFrame();
      flushAnimationFrame();
      flushScheduledMicrotasks();
    });
    // 窗口态首帧没有滚动记忆 → 贴底（1200 − 300）。
    expect(timeline.scrollTop).toBe(900);
    // 用户上滚：视口顶部落在 turn-w2 内（unit 起点 400、scrollTop 250 ⇒ 视口内偏移 150）。
    act(() => {
      virtualizer.getVirtualItemForOffset.mockReturnValue(measurement("turn-w2", 1, 400));
      dispatchWheel(timeline, -120);
      timeline.scrollTop = 250;
      dispatchScroll(timeline);
    });
    expect(timeline.getAttribute("data-following")).toBe("false");
    return { container, timeline };
  }

  it("按翻转前视口顶部的 turn key 重锚定，并作废旧空间的测高与锚点", () => {
    const { timeline } = mountWindowStateWithUserScroll();
    virtualizer.measure.mockClear();

    // 补全：权威全序行 + 新空间 measurement（更早内容插到前面，turn-w2 起点变成 10600）。
    act(() => {
      layout.scrollHeight = 20000;
      virtualizer.measurementsCache = [
        measurement("turn-e1", 0, 0),
        measurement("turn-e2", 1, 5000),
        measurement("turn-w1", 2, 10000),
        measurement("turn-w2", 3, 10600),
        measurement("turn-w3", 4, 10700),
      ];
      renderTimeline(mountedRoot!, "session-cold", KEY, ROWS_AUTHORITATIVE);
    });

    // 目标 scrollTop = 新起点 10600 − 翻转前视口内偏移 150；既不落在旧空间的 250，
    // 也不是任何按旧起点补偿出来的像素。
    expect(timeline.scrollTop).toBe(10450);
    expect(timeline.getAttribute("data-following")).toBe("false");
    // 旧空间的测高整份作废（turnId 相同但量已换空间，不能继续复用）。
    expect(virtualizer.measure).toHaveBeenCalled();
  });

  it("锚 turn 不在权威尾窗里：回到「打开会话」的贴底语义", () => {
    const { container, timeline } = mountWindowStateWithUserScroll();

    act(() => {
      layout.scrollHeight = 20000;
      virtualizer.measurementsCache = [
        measurement("turn-e1", 0, 0),
        measurement("turn-e2", 1, 5000),
      ];
      renderTimeline(mountedRoot!, "session-cold", KEY, ROWS_AUTHORITATIVE);
    });

    expect(timeline.scrollTop).toBe(19700);
    expect(timeline.getAttribute("data-following")).toBe("true");
    expect(findByTestId(container, TID_V4_TIMELINE_BOTTOM)).toBeNull();
  });
});
