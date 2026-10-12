import type { AppSettings } from "@zcode/shared";
import type { InputRouting, SessionConfigState } from "@zcode/shared/zcode-protocol-v4";

export function resolveAppFollowupMode(
  settings: AppSettings | null | undefined,
): SessionConfigState["followupMode"] | null {
  if (!settings) return null;
  return settings.zcodeInteractionBehavior === "guide" ? "guide" : "queue";
}

/**
 * 修饰键到投递模式的固定映射，与全局 followupMode 无关（spec: composer-per-send-delivery）。
 * guide 只在 busy 时有意义；primary（⌘/Ctrl=立即）恒有效——idle 时 CLI 自然按新 turn 处理。
 */
export type ModifierDelivery = "startNow" | "guide";

export function resolveDeliveryForModifiers({
  primary,
  alt,
  busy,
}: {
  primary: boolean;
  alt: boolean;
  busy: boolean;
}): ModifierDelivery | undefined {
  if (primary) return "startNow";
  if (alt && busy) return "guide";
  return undefined;
}

export function shouldEnableModifiedEnterSubmit({
  inputRoutingMode,
  isMobileTextInputViewport,
  isWebRemoteControl,
}: {
  inputRoutingMode: InputRouting["mode"];
  isMobileTextInputViewport: boolean;
  isWebRemoteControl: boolean;
}): boolean {
  // Bug 原因：旧门禁把 draft 和通用移动媒体查询当成了“手机端”，导致桌面新任务以及
  // Windows 窄窗口/触屏设备都没有注册 Ctrl+Enter，事件最终退回 Lexical 默认换行。
  // 产品边界是手机 Web 远控；桌面 continuous 链路不应被视口或指针能力改变语义。
  return inputRoutingMode !== "reject" && !(isWebRemoteControl && isMobileTextInputViewport);
}

export function resolvePointerDelivery({
  enabled,
  metaKey = false,
  ctrlKey = false,
  altKey = false,
  busy,
  isApplePlatform,
}: {
  enabled: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  busy: boolean;
  isApplePlatform?: boolean;
}): ModifierDelivery | undefined {
  if (!enabled) return undefined;
  const primary =
    isApplePlatform === undefined
      ? metaKey || ctrlKey
      : isPrimaryFollowupModifierPressed({ isApplePlatform, metaKey, ctrlKey });
  return resolveDeliveryForModifiers({ primary, alt: altKey, busy });
}

export function isPrimaryFollowupModifierPressed({
  isApplePlatform,
  metaKey = false,
  ctrlKey = false,
}: {
  isApplePlatform: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
}): boolean {
  return isApplePlatform ? metaKey : ctrlKey;
}

export interface FollowupModifierTooltip {
  delivery: ModifierDelivery;
  shortcut: string;
  titleId: "chat.followup.sendNow" | "chat.followup.guideCurrent";
}

export function resolveFollowupModifierTooltip({
  enabled,
  canSend,
  primaryPressed,
  altPressed,
  isApplePlatform,
}: {
  enabled: boolean;
  canSend: boolean;
  primaryPressed: boolean;
  altPressed: boolean;
  isApplePlatform: boolean;
}): FollowupModifierTooltip | null {
  if (!enabled || !canSend) return null;
  // enabled 已含 busy 条件，这里 alt 恒可表达 guide。
  const delivery = resolveDeliveryForModifiers({
    primary: primaryPressed,
    alt: altPressed,
    busy: true,
  });
  if (!delivery) return null;
  return {
    delivery,
    shortcut:
      delivery === "startNow"
        ? isApplePlatform
          ? "⌘ + Enter"
          : "Ctrl + Enter"
        : isApplePlatform
          ? "⌥ + Enter"
          : "Alt + Enter",
    titleId: delivery === "startNow" ? "chat.followup.sendNow" : "chat.followup.guideCurrent",
  };
}
