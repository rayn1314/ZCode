// 渲染失败 → 协议 errorKind 归类、注入详情与报告去重键（spec gen-ui-cross-host-render.md）。
// errorKind 是跨端契约枚举，不透传 files.ts 的原始英文错误串；归类失败回落 other。
import { GEN_UI_FRAGMENT_REQUIRED_MESSAGE } from "@zcode/shared/gen-ui";
import {
  GEN_UI_RENDER_FAILURE_DETAIL_MAX_LENGTH,
  type ZCodeGenUiRenderFailureKind,
} from "@zcode/shared";

export function classifyGenUiRenderFailure(errorText: string): ZCodeGenUiRenderFailureKind {
  if (
    /outside the host output directory|escaped the output directory|does not read symbolic links/u.test(
      errorText,
    )
  ) {
    return "outside_root";
  }
  if (/invalid executor path/iu.test(errorText)) {
    return "invalid_path";
  }
  // 读端抛出的这条消息与这里归类共用同一常量（@zcode/shared/gen-ui），两侧不会漂移。
  if (errorText.includes(GEN_UI_FRAGMENT_REQUIRED_MESSAGE)) {
    return "invalid_fragment";
  }
  if (/sandbox mismatch/u.test(errorText)) {
    return "sandbox_mismatch";
  }
  if (/enoent|no such file|not found/iu.test(errorText)) {
    return "not_found";
  }
  return "other";
}

/**
 * 上报给 CLI 的失败详情：折成一行并按上限截断。
 * 它既进注入文本（模型据此看到读端到底拒了什么），也进去重键——形态违规的消息里带内容
 * 指纹，所以模型改写文件后仍同类失败能再提醒一次，而同一份内容不会重复提醒。
 */
export function buildGenUiRenderFailureDetail(errorText: string): string | undefined {
  let collapsed = "";
  for (const char of errorText) {
    const code = char.codePointAt(0) ?? 0;
    collapsed += code < 0x20 || code === 0x7f ? " " : char;
  }
  collapsed = collapsed.replace(/\s+/gu, " ").trim();
  if (!collapsed) return undefined;
  return collapsed.length > GEN_UI_RENDER_FAILURE_DETAIL_MAX_LENGTH
    ? `${collapsed.slice(0, GEN_UI_RENDER_FAILURE_DETAIL_MAX_LENGTH - 1)}…`
    : collapsed;
}

export function buildGenUiRenderFailureKey(params: {
  sessionId: string;
  path: string;
  errorKind: ZCodeGenUiRenderFailureKind;
  detail?: string;
}): string {
  return `${params.sessionId}\u0000${params.path}\u0000${params.errorKind}\u0000${params.detail ?? ""}`;
}
