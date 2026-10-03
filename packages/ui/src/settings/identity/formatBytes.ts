const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/**
 * 迁移域体积的人类可读展示（二进制单位，与仓库里附件体积的口径一致）。
 * 只服务界面展示，不参与任何写入决策。
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const unit = BYTE_UNITS[unitIndex];
  if (unitIndex === 0) {
    return `${Math.round(value)} ${unit}`;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
}
