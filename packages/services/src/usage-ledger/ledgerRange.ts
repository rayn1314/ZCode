import type { LedgerRangeInfo, LedgerSnapshotRequest } from "@zcode/shared";

export const MS_PER_DAY = 86_400_000;

export function localTzOffsetMinutes(nowMs = Date.now()): number {
  return -new Date(nowMs).getTimezoneOffset();
}

export interface ZoneDay {
  year: number;
  month: number;
  day: number;
}

export function todayInZone(offsetMinutes: number, nowMs: number): ZoneDay {
  const shifted = new Date(nowMs + offsetMinutes * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

export function dayStartMsInZone(offsetMinutes: number, day: ZoneDay): number {
  return Date.UTC(day.year, day.month - 1, day.day) - offsetMinutes * 60_000;
}

/** 分桶日序号（(started_at + 偏移) 整除一天）转 YYYY-MM-DD。 */
export function dayIdxToDateString(dayIdx: number): string {
  return new Date(dayIdx * MS_PER_DAY).toISOString().slice(0, 10);
}

const YMD_RE = /^\d+$/;

function parseYmd(value: string): ZoneDay {
  const parts = value.trim().split("-");
  if (parts.length !== 3 || !parts.every((p) => YMD_RE.test(p))) {
    throw new Error("LEDGER_INVALID_CUSTOM_RANGE");
  }
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error("LEDGER_INVALID_CUSTOM_RANGE");
  }
  return { year, month, day };
}

export function resolveLedgerRange(
  request: LedgerSnapshotRequest,
  nowMs: number,
  offsetMinutes: number,
): LedgerRangeInfo {
  const today = todayInZone(offsetMinutes, nowMs);
  const today0 = dayStartMsInZone(offsetMinutes, today);
  switch (request.range) {
    case "today":
      return { key: "today", fromMs: today0, toMs: nowMs };
    case "7d":
      return { key: "7d", fromMs: today0 - 6 * MS_PER_DAY, toMs: nowMs };
    case "30d":
      return { key: "30d", fromMs: today0 - 29 * MS_PER_DAY, toMs: nowMs };
    case "all":
      // 上界不能留 null，否则 SQL 里 started_at <= NULL 恒不成立
      return { key: "all", fromMs: null, toMs: nowMs };
    case "custom": {
      const d1 = parseYmd(request.customStart ?? "");
      const d2 = parseYmd(request.customEnd ?? "");
      const [start, end] =
        Date.UTC(d1.year, d1.month - 1, d1.day) <= Date.UTC(d2.year, d2.month - 1, d2.day)
          ? [d1, d2]
          : [d2, d1];
      return {
        key: "custom",
        fromMs: dayStartMsInZone(offsetMinutes, start),
        toMs: dayStartMsInZone(offsetMinutes, end) + MS_PER_DAY - 1,
      };
    }
    default:
      return { key: "30d", fromMs: today0 - 29 * MS_PER_DAY, toMs: nowMs };
  }
}
