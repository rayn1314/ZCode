// 渲染失败 → 协议 errorKind 归类与报告去重键（spec gen-ui-cross-host-render.md）。
// errorKind 是跨端契约枚举，不透传 files.ts 的原始英文错误串；归类失败回落 other。
import type { ZCodeGenUiRenderFailureKind } from "@zcode/shared";

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
  if (/sandbox mismatch/u.test(errorText)) {
    return "sandbox_mismatch";
  }
  if (/enoent|no such file|not found/iu.test(errorText)) {
    return "not_found";
  }
  return "other";
}

export function buildGenUiRenderFailureKey(params: {
  sessionId: string;
  path: string;
  errorKind: ZCodeGenUiRenderFailureKind;
}): string {
  return `${params.sessionId}\u0000${params.path}\u0000${params.errorKind}`;
}
