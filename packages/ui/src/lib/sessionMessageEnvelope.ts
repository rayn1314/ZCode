/**
 * 跨会话投递信封的渲染期解析。
 *
 * 信封字节形态由 services / CLI 的注入文本产出方冻结（有逐字节测试断言），UI 只读：
 * 这里既不生成也不改写信封，只把它从用户消息正文里剥出来，交给「上下文引用」管道渲染。
 * spec: packages/ui/spec/session-message-envelope-rendering.md
 */

export interface SessionMessageEnvelopeReference {
  /** 原始信封文本（含开闭标签与全部属性）。编辑回写时按原样拼回，绝不能丢。 */
  raw: string;
  /** 来自开标签的 source 属性；缺失时为 undefined。不枚举取值，将来新增产出方 UI 无需改。 */
  source?: string;
  messageId: string;
  fromSessionId?: string;
  senderKind?: string;
  hop?: string;
  origin?: string;
  createdAt?: string;
  requestId?: string;
  /** 信封内正文，已剔除给模型看的英文样板行；仅用于展示。 */
  body: string;
}

const OPEN_TAG_PATTERN = /<session-message(?=[\s>])((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const CLOSE_TAG = "</session-message>";
const ATTRIBUTE_PATTERN = /([A-Za-z0-9_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
/** 给模型看的样板行，产出方各有一句措辞；卡片自身已表达同一语义，展示正文不再重复。 */
const MODEL_BOILERPLATE_PREFIXES = ["For reference only.", "Delivery of message "];

const ATTRIBUTE_FIELDS = {
  source: "source",
  message_id: "messageId",
  from_session: "fromSessionId",
  sender_kind: "senderKind",
  hop: "hop",
  origin: "origin",
  created_at: "createdAt",
  request_id: "requestId",
} as const;

type AttributeName = keyof typeof ATTRIBUTE_FIELDS;

interface OpeningTag {
  start: number;
  end: number;
  attributes: Map<string, string>;
}

/**
 * 产出方对属性值转义了 `&` / `"` / `<`，展示时要还原成用户看到的值；
 * `&amp;` 必须最后解，否则 `&amp;lt;` 会被二次解码。
 */
function decodeAttributeValue(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

function findOpeningTag(text: string, from: number): OpeningTag | null {
  OPEN_TAG_PATTERN.lastIndex = from;
  const match = OPEN_TAG_PATTERN.exec(text);
  if (match?.index === undefined) return null;
  const rawAttributes = match[1] ?? "";
  const attributes = new Map<string, string>();
  ATTRIBUTE_PATTERN.lastIndex = 0;
  let attribute: RegExpExecArray | null;
  while ((attribute = ATTRIBUTE_PATTERN.exec(rawAttributes)) !== null) {
    const key = attribute[1]?.toLowerCase();
    if (!key) continue;
    // 未知属性直接忽略：新增产出方不需要同步改这里。
    attributes.set(key, decodeAttributeValue(attribute[2] ?? attribute[3] ?? ""));
  }
  return { start: match.index, end: match.index + match[0].length, attributes };
}

function readAttribute(attributes: Map<string, string>, name: AttributeName): string | undefined {
  const value = attributes.get(name);
  return value === undefined || value.length === 0 ? undefined : value;
}

function isModelBoilerplateLine(line: string): boolean {
  const trimmedStart = line.trimStart();
  return MODEL_BOILERPLATE_PREFIXES.some((prefix) => trimmedStart.startsWith(prefix));
}

function extractBody(rawBody: string): string {
  const lines = rawBody.split("\n").filter((line) => !isModelBoilerplateLine(line));
  // 样板行与其相邻空行都是产出方 `\n` 拼接的产物，只归整首尾，不动正文自身的空行结构。
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] ?? "").trim() === "") start += 1;
  while (end > start && (lines[end - 1] ?? "").trim() === "") end -= 1;
  return lines.slice(start, end).join("\n").trimEnd();
}

/** 剥离点两侧的空白是残留，归一成一个空行；只有一侧有内容时不留空行。 */
function joinAcrossRemoval(left: string, right: string): string {
  const head = left.replace(/\s+$/, "");
  const tail = right.replace(/^\s+/, "");
  if (!head) return tail;
  if (!tail) return head;
  return `${head}\n\n${tail}`;
}

export function parseSessionMessageEnvelopes(text: string): {
  visibleContent: string;
  messages: SessionMessageEnvelopeReference[];
} {
  const messages: SessionMessageEnvelopeReference[] = [];
  const removals: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (;;) {
    const opening = findOpeningTag(text, cursor);
    if (!opening) break;
    const closeIndex = text.indexOf(CLOSE_TAG, opening.end);
    // 没有闭合标签：后续也不可能有配对，整条按普通正文处理。
    if (closeIndex === -1) break;
    const messageId = readAttribute(opening.attributes, "message_id");
    if (!messageId) {
      // 缺 message_id 不认信封（用户手打不出这种属性，误吞正文的代价远高于漏认），
      // 但继续从开标签之后扫描，避免整段文本里的合法信封被一起放过。
      cursor = opening.end;
      continue;
    }
    const end = closeIndex + CLOSE_TAG.length;
    messages.push({
      raw: text.slice(opening.start, end),
      source: readAttribute(opening.attributes, "source"),
      messageId,
      fromSessionId: readAttribute(opening.attributes, "from_session"),
      senderKind: readAttribute(opening.attributes, "sender_kind"),
      hop: readAttribute(opening.attributes, "hop"),
      origin: readAttribute(opening.attributes, "origin"),
      createdAt: readAttribute(opening.attributes, "created_at"),
      requestId: readAttribute(opening.attributes, "request_id"),
      body: extractBody(text.slice(opening.end, closeIndex)),
    });
    removals.push({ start: opening.start, end });
    cursor = end;
  }
  // 不吞正文：没有任何信封（或全不完整）时逐字节原样返回。
  if (removals.length === 0) return { visibleContent: text, messages };

  const segments: string[] = [];
  let segmentStart = 0;
  for (const removal of removals) {
    segments.push(text.slice(segmentStart, removal.start));
    segmentStart = removal.end;
  }
  segments.push(text.slice(segmentStart));
  let visibleContent = segments[0] ?? "";
  for (let index = 1; index < segments.length; index += 1) {
    visibleContent = joinAcrossRemoval(visibleContent, segments[index] ?? "");
  }
  return { visibleContent: visibleContent.trim(), messages };
}

export function buildPromptWithSessionMessageEnvelopes(
  visibleContent: string,
  messages: readonly SessionMessageEnvelopeReference[],
): string {
  if (messages.length === 0) return visibleContent;
  // 回写一律用 raw：信封是协议契约，body 只是展示投影，不能作为落库内容。
  const block = messages.map((message) => message.raw).join("\n\n");
  return visibleContent ? `${visibleContent}\n\n${block}` : block;
}
