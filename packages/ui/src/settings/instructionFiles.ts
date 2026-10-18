import type {
  IInstructionsService,
  InstructionFileState,
  InstructionFileWriteFailureReason,
  IServiceAccessor,
} from "@zcode/services";
import { INSTRUCTION_FILE_MAX_BYTES, type InstructionScope } from "@zcode/shared";
import type { IntlInstance } from "@/i18n/IntlProvider.js";

/**
 * 指令文件（AGENTS.md）设置页的契约与纯逻辑。
 *
 * 快照与读写签名直接引用 `@zcode/services` 的 `IInstructionsService`：上限与作用域类型来自
 * `@zcode/shared` 的 `instruction-files`（与 Agent 侧读取器同源），三条链路共享同一份契约，
 * 本文件不再保留同构的第二份声明。服务解析收敛到 `resolveInstructionsService` 一个注入点：
 * 缺失（旧 host / 服务未注册通道）时页面按加载失败态渲染，不自行实现服务、也不散落断言。
 */

export { INSTRUCTION_FILE_MAX_BYTES };
export type { InstructionScope };

export type InstructionFileSnapshot = InstructionFileState;
export type InstructionsService = IInstructionsService;
export type InstructionFileWriteResult =
  | { ok: true }
  | { ok: false; reason: InstructionFileWriteFailureReason; message?: string };

/**
 * 唯一的服务注入点。用运行时形状校验代替类型断言，避免服务缺失（旧 host / 未联调）
 * 时把 `undefined.readInstructionFile` 抛成运行时异常；缺失时返回 null 由调用方渲染失败态。
 */
export function resolveInstructionsService(
  services: IServiceAccessor | null | undefined,
): InstructionsService | null {
  const candidate = (services as { instructionsService?: unknown } | null | undefined)
    ?.instructionsService;
  if (!candidate || typeof candidate !== "object") {
    return null;
  }
  const service = candidate as Partial<InstructionsService>;
  return typeof service.readInstructionFile === "function" &&
    typeof service.writeInstructionFile === "function"
    ? (service as InstructionsService)
    : null;
}

/**
 * 新建指令文件的骨架：只给标题结构，不预填任何猜测内容。
 * 「工作区概览」是 H1，其余三节作为 H2 便于后续人工扩写。
 */
export function buildInstructionTemplate(formatMessage: IntlInstance["formatMessage"]): string {
  const [overview, commands, conventions, acceptance] = [
    "settings.instructions.template.overview",
    "settings.instructions.template.commands",
    "settings.instructions.template.conventions",
    "settings.instructions.template.acceptance",
  ].map((id) => formatMessage({ id }));

  return `# ${overview}\n\n## ${commands}\n\n## ${conventions}\n\n## ${acceptance}\n`;
}

/** 字节数展示：单位符号通用，不做 i18n；1024 进制与文件管理器口径一致。 */
export function formatInstructionBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }
  const kib = bytes / 1024;
  if (kib < 1024) {
    return `${kib.toFixed(kib >= 100 ? 0 : 1)} KB`;
  }
  const mib = kib / 1024;
  return `${mib.toFixed(mib >= 10 ? 0 : 1)} MB`;
}

/** 上次修改时间；mtime 缺失（未创建 / host 未提供）返回 null，由调用方决定不展示。 */
export function formatInstructionMtime(mtimeMs: number | null, locale: string): string | null {
  if (mtimeMs === null || !Number.isFinite(mtimeMs) || mtimeMs <= 0) {
    return null;
  }
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
    mtimeMs,
  );
}
