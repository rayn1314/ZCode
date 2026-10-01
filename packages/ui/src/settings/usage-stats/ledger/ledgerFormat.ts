// 账本面板的展示格式化：费用、时长、相对时间。
// token 数字复用 usage-stats 既有的 formatCompactTokenUsage / formatCompactNumber。

export function formatLedgerCost(locale: string, value: number, currency: string): string {
  const abs = Math.abs(value);
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currency === "CNY" ? "CNY" : "USD",
    // 小额费用保留足够精度，大额收紧
    maximumFractionDigits: abs >= 100 ? 2 : abs >= 1 ? 3 : 4,
    minimumFractionDigits: abs >= 100 ? 2 : 0,
  }).format(value);
}

export function formatLedgerDuration(
  locale: string,
  ms: number | null,
  units: { second: string; minute: string; hour: string },
): string {
  if (ms === null || !Number.isFinite(ms)) {
    return "--";
  }
  if (ms < 1000) {
    return `${Math.max(0, Math.round(ms))} ms`;
  }
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(totalSeconds < 10 ? 1 : 0)} ${units.second}`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds - totalMinutes * 60);
  if (totalMinutes < 60) {
    return seconds > 0
      ? `${totalMinutes} ${units.minute} ${seconds} ${units.second}`
      : `${totalMinutes} ${units.minute}`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours} ${units.hour} ${minutes} ${units.minute}`;
}

export function formatLedgerRelativeTime(locale: string, timeMs: number | null): string {
  if (timeMs === null || !Number.isFinite(timeMs)) {
    return "--";
  }
  const diffSeconds = Math.round((timeMs - Date.now()) / 1000);
  const absSeconds = Math.abs(diffSeconds);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (absSeconds < 60) {
    return formatter.format(diffSeconds, "second");
  }
  if (absSeconds < 3600) {
    return formatter.format(Math.round(diffSeconds / 60), "minute");
  }
  if (absSeconds < 86_400) {
    return formatter.format(Math.round(diffSeconds / 3600), "hour");
  }
  return formatter.format(Math.round(diffSeconds / 86_400), "day");
}

export function formatLedgerClock(locale: string, timeMs: number): string {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timeMs));
}

export function formatLedgerHourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

/** 项目目录只留末两段，中间折叠（与账本工具口径一致）。 */
export function shortenLedgerDirectory(directory: string | null): string {
  if (!directory) {
    return "--";
  }
  const segments = directory
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .filter(Boolean);
  if (segments.length <= 2) {
    return segments.join("/") || "/";
  }
  return `${segments[0]}/…/${segments[segments.length - 1]}`;
}
