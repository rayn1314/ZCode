import type { DatabaseSync } from "node:sqlite";
import type {
  MessageId,
  MessageInfo,
  MessagePart,
  MessageWithParts,
  PartId,
  SessionId,
  SessionMessageSlice,
  SessionStorePort,
} from "@zcode/contracts";
import { decodeMessageRow, decodePartRow, partCreatedAt } from "../codecs.js";
import { encodeJson } from "../json.js";
import type { MessageRow, PartRow } from "../rows.js";
import { touchSession } from "./sessions.js";

// 只补回旧版快照字段，不合并整个 JSON：递归 merge 会让已清空的 metadata/options 残留。
function preserveLegacyMembers(table: "message" | "part", keys: readonly string[]): string {
  return keys.reduce(
    (sql, key) =>
      `(select case when json_type(${table}.data, '$.${key}') is not null
      then json_set(previous.data, '$.${key}', json_extract(${table}.data, '$.${key}')) else previous.data end
      from (select ${sql} as data) as previous)`,
    "excluded.data",
  );
}

const MESSAGE_DATA_UPDATE = preserveLegacyMembers("message", [
  "model",
  "providerID",
  "modelID",
  "variant",
]);
const PART_DATA_UPDATE = preserveLegacyMembers("part", ["fromModel", "toModel", "model"]);

// on-conflict 的 sequence 规则：
// 同 scope 再保存必须原样保留现有 sequence——包括 NULL。coalesce(existing, excluded)
// 会把 NULL 历史行（迁移遗漏/旧版本二进制写入）在任何一次再保存时重排到队尾（excluded=max+1），
// assistant 完成后的二次 save 就足以触发，造成时间线漂移；NULL 由 0015 backfill 统一修复。
// 跨 scope 改绑（id 冲突但 session/message 不同，仅导入 upsert 场景）才取 excluded 的新 scope 队尾。
export async function saveMessage(
  db: DatabaseSync,
  input: MessageInfo,
  copyFrom?: Parameters<SessionStorePort["saveMessage"]>[1],
): Promise<void> {
  const { id, sessionID, ...data } = input;
  // 冻结旧版协议 mapper 无条件读取 user.model；缺少整个对象会让正文也无法打开。
  // 只补必需对象；旧行的原 model 仍由冲突更新/复制逻辑保留，新版 Reader 不使用它。
  const storedData =
    input.role === "user"
      ? {
          ...data,
          model: input.modelSelection
            ? {
                providerID: input.modelSelection.providerId,
                modelID: input.modelSelection.modelId,
                ...(input.modelSelection.options?.reasoningLevel
                  ? { variant: input.modelSelection.options.reasoningLevel }
                  : {}),
              }
            : {},
        }
      : data;
  const timeCreated = input.time.created;
  const timeUpdated =
    input.role === "assistant" ? (input.time.completed ?? Date.now()) : timeCreated;

  db.prepare(
    `
      insert into message (id, session_id, time_created, time_updated, data, sequence)
      values (
        ?,
        ?,
        ?,
        ?,
        ?,
        (
          select coalesce(max(sequence), -1) + 1
          from message
          where session_id = ?
        )
      )
      on conflict(id) do update set
        session_id = excluded.session_id,
        time_updated = excluded.time_updated,
        -- 旧字段是回滚快照，不能因新版 Reader 隐藏了它们而在普通更新时丢掉。
        data = case when message.session_id = excluded.session_id then ${MESSAGE_DATA_UPDATE} else excluded.data end,
        sequence = case
          when message.session_id = excluded.session_id then message.sequence
          else excluded.sequence
        end
      `,
  ).run(
    id,
    sessionID,
    timeCreated,
    timeUpdated,
    encodeJson(copyLegacyMembers(db, "message", storedData, copyFrom)),
    sessionID,
  );
  touchSession(db, sessionID, timeUpdated);
}

export async function removeMessage(
  db: DatabaseSync,
  input: { sessionID: SessionId; messageID: MessageId },
): Promise<void> {
  db.prepare("delete from message where id = ? and session_id = ?").run(
    input.messageID,
    input.sessionID,
  );
}

export async function savePart(
  db: DatabaseSync,
  input: MessagePart,
  copyFrom?: Parameters<SessionStorePort["savePart"]>[1],
): Promise<void> {
  const { id, sessionID, messageID, ...data } = input;
  let storedData: Record<string, unknown> = data;
  if (input.type === "timeline" && input.timelineType === "model_change") {
    const { fromModel, toModel, ...part } = data as typeof input;
    // 冻结旧版 Reader 直接访问 toModel.providerID；只为这一个必需对象做最小兼容写入。
    // 当前 Reader 不读它，更新同一旧行时 SQL 保留原快照，不持续反向同步。
    const oldToModel = toModel
      ? {
          providerID: toModel.providerId,
          modelID: toModel.modelId,
          ...(toModel.options?.reasoningLevel ? { variant: toModel.options.reasoningLevel } : {}),
          label: toModel.label,
        }
      : {};
    storedData = {
      ...part,
      toModel: oldToModel,
      fromModelSelection: fromModel,
      toModelSelection: toModel,
    };
  } else if (input.type === "subtask") {
    const { model, ...part } = data as typeof input;
    storedData = { ...part, modelSelection: model };
  }
  const now = Date.now();

  db.prepare(
    `
      insert into part (id, message_id, session_id, time_created, time_updated, data, sequence)
      values (
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        (
          select coalesce(max(sequence), -1) + 1
          from part
          where message_id = ?
        )
      )
      on conflict(id) do update set
        message_id = excluded.message_id,
        session_id = excluded.session_id,
        time_updated = excluded.time_updated,
        data = case when part.message_id = excluded.message_id and part.session_id = excluded.session_id
          then ${PART_DATA_UPDATE} else excluded.data end,
        sequence = case
          when part.message_id = excluded.message_id and part.session_id = excluded.session_id
            then part.sequence
          else excluded.sequence
        end
      `,
  ).run(
    id,
    messageID,
    sessionID,
    partCreatedAt(input, now),
    now,
    encodeJson(copyLegacyMembers(db, "part", storedData, copyFrom)),
    messageID,
  );
  touchSession(db, sessionID, now);
}

function copyLegacyMembers(
  db: DatabaseSync,
  table: "message" | "part",
  data: Record<string, unknown>,
  source: Parameters<SessionStorePort["saveMessage"]>[1],
): Record<string, unknown> {
  if (!source) return data;
  // 复制只搬运存储快照；运行层不读取旧字段，也不能凭当前选择重建旧值。
  const row = db
    .prepare(`SELECT data FROM ${table} WHERE id=? AND session_id=?`)
    .get(source.id, source.sessionID);
  if (!row) throw new Error(`Storage copy source missing: ${table}/${source.id}`);
  const original = JSON.parse(String(row.data)) as Record<string, unknown>;
  const result = { ...data };
  const keys =
    table === "message"
      ? ["model", "providerID", "modelID", "variant"]
      : ["fromModel", "toModel", "model"];
  for (const key of keys) if (Object.hasOwn(original, key)) result[key] = original[key];
  return result;
}

export async function removePart(
  db: DatabaseSync,
  input: {
    sessionID: SessionId;
    messageID: MessageId;
    partID: PartId;
  },
): Promise<void> {
  db.prepare("delete from part where id = ? and message_id = ? and session_id = ?").run(
    input.partID,
    input.messageID,
    input.sessionID,
  );
}

export async function messages(
  db: DatabaseSync,
  input: { sessionID: SessionId },
): Promise<MessageWithParts[]> {
  const messageRows = db
    .prepare(
      `
      select * from message
      where session_id = ?
      order by sequence is null, sequence, time_created, rowid
      `,
    )
    .all(input.sessionID) as unknown as MessageRow[];

  const partRows = db
    .prepare(
      `
      select * from part
      where session_id = ?
      order by message_id, sequence is null, sequence, time_created, id
      `,
    )
    .all(input.sessionID) as unknown as PartRow[];
  const partsByMessage = new Map<string, MessagePart[]>();

  for (const row of partRows) {
    const part = decodePartRow(row);
    const list = partsByMessage.get(row.message_id) ?? [];
    list.push(part);
    partsByMessage.set(row.message_id, list);
  }

  return messageRows.map((row) => ({
    info: decodeMessageRow(row),
    parts: partsByMessage.get(row.id) ?? [],
  }));
}

export async function messageWithParts(
  db: DatabaseSync,
  input: { sessionID: SessionId; messageID: MessageId },
): Promise<MessageWithParts | null> {
  const messageRow = db
    .prepare("select * from message where id = ? and session_id = ?")
    .get(input.messageID, input.sessionID) as unknown as MessageRow | undefined;
  if (!messageRow) return null;

  const partRows = db
    .prepare(
      `
      select * from part
      where message_id = ? and session_id = ?
      order by sequence is null, sequence, time_created, id
      `,
    )
    .all(input.messageID, input.sessionID) as unknown as PartRow[];
  return {
    info: decodeMessageRow(messageRow),
    parts: partRows.map(decodePartRow),
  };
}

/**
 * 尾部窗口 / 游标分页的统一读路径（`messageWindow` 与 `messagePageBefore` 共用）。
 *
 * 性能约束（spec: cold-open-window-first §1）：只读**尾部窗口**——元信息走
 * `count/min/sum` 聚合，正文按 `(session_id, sequence)` 索引倒序取 `limit + 1` 条判 `hasOlder`，
 * 不对全表排序、不读窗口之外的 `data`。`order by sequence desc, time_created desc, id desc`
 * 与索引列序一致；`sequence` 在会话内由存储层维护为唯一递增（0014/0015），故这里的全序
 * 与 `messages()` 的规范全序一致。
 */
export async function messageSlice(
  db: DatabaseSync,
  input: { sessionID: SessionId; beforeSequence?: number; limit: number },
): Promise<SessionMessageSlice> {
  const meta = db
    .prepare(
      `
      select count(*) as total,
             sum(case when sequence is null then 1 else 0 end) as null_count,
             min(sequence) as first_sequence
      from message
      where session_id = ?
      `,
    )
    .get(input.sessionID) as unknown as {
    total: number;
    null_count: number | null;
    first_sequence: number | null;
  };
  const totalCount = Number(meta.total ?? 0);
  const firstSequence = meta.first_sequence === null ? null : Number(meta.first_sequence);
  // NULL sequence 旧行的规范顺序排在非空行之前，尾部窗口按 sequence 倒序无法表达它；
  // 交给调用方回退既有全量路径，而不是在这里拼一个近似顺序。
  if (Number(meta.null_count ?? 0) > 0) {
    return { messages: [], sequences: [], totalCount, firstSequence, hasOlder: false, legacySequence: true };
  }
  if (totalCount === 0) {
    return {
      messages: [],
      sequences: [],
      totalCount: 0,
      firstSequence: null,
      hasOlder: false,
      legacySequence: false,
    };
  }

  const hasCursor = input.beforeSequence !== undefined;
  const fetchLimit = input.limit + 1;
  const tailRows = (
    hasCursor
      ? db
          .prepare(
            `
            select * from message
            where session_id = ? and sequence < ?
            order by sequence desc, time_created desc, id desc
            limit ?
            `,
          )
          .all(input.sessionID, input.beforeSequence as number, fetchLimit)
      : db
          .prepare(
            `
            select * from message
            where session_id = ?
            order by sequence desc, time_created desc, id desc
            limit ?
            `,
          )
          .all(input.sessionID, fetchLimit)
  ) as unknown as MessageRow[];
  const hasOlder = tailRows.length > input.limit;
  const page = hasOlder ? tailRows.slice(0, input.limit) : tailRows;
  page.reverse();

  // part 只读本页消息的：子查询与正文同一索引，避免 IN 列表拼 SQL（值仍全部参数绑定）。
  const partRows = (
    hasCursor
      ? db
          .prepare(
            `
            select * from part
            where session_id = ? and message_id in (
              select id from message
              where session_id = ? and sequence < ?
              order by sequence desc, time_created desc, id desc
              limit ?
            )
            order by message_id, sequence is null, sequence, time_created, id
            `,
          )
          .all(input.sessionID, input.sessionID, input.beforeSequence as number, fetchLimit)
      : db
          .prepare(
            `
            select * from part
            where session_id = ? and message_id in (
              select id from message
              where session_id = ?
              order by sequence desc, time_created desc, id desc
              limit ?
            )
            order by message_id, sequence is null, sequence, time_created, id
            `,
          )
          .all(input.sessionID, input.sessionID, fetchLimit)
  ) as unknown as PartRow[];
  const partsByMessage = new Map<string, MessagePart[]>();
  for (const row of partRows) {
    const part = decodePartRow(row);
    const list = partsByMessage.get(row.message_id) ?? [];
    list.push(part);
    partsByMessage.set(row.message_id, list);
  }

  return {
    messages: page.map((row) => ({
      info: decodeMessageRow(row),
      parts: partsByMessage.get(row.id) ?? [],
    })),
    sequences: page.map((row) => Number(row.sequence)),
    totalCount,
    firstSequence,
    hasOlder,
    legacySequence: false,
  };
}

export async function messageWindow(
  db: DatabaseSync,
  input: { sessionID: SessionId; limit: number },
): Promise<SessionMessageSlice> {
  return messageSlice(db, input);
}

export async function messagePageBefore(
  db: DatabaseSync,
  input: { sessionID: SessionId; beforeSequence?: number; limit: number },
): Promise<SessionMessageSlice> {
  return messageSlice(db, input);
}
