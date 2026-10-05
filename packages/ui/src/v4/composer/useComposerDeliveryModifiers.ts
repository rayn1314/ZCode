import { useSyncExternalStore } from "react";
import { isAppleKeyboardPlatform } from "@/lib/keyboardShortcuts.js";
import { isPrimaryFollowupModifierPressed } from "@/v4/composer/followupModeSettings.js";

export interface ComposerDeliveryModifiers {
  primary: boolean;
  alt: boolean;
}

const listeners = new Set<() => void>();
let snapshot: ComposerDeliveryModifiers = { primary: false, alt: false };
let detachWindowListeners: (() => void) | null = null;

function publish(next: ComposerDeliveryModifiers): void {
  if (snapshot.primary === next.primary && snapshot.alt === next.alt) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

function attachWindowListeners(): () => void {
  const syncModifiers = (event: KeyboardEvent) => {
    publish({
      primary: isPrimaryFollowupModifierPressed({
        isApplePlatform: isAppleKeyboardPlatform(),
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
      }),
      alt: event.altKey,
    });
  };
  const clearModifiers = () => publish({ primary: false, alt: false });
  window.addEventListener("keydown", syncModifiers);
  window.addEventListener("keyup", syncModifiers);
  window.addEventListener("blur", clearModifiers);
  return () => {
    window.removeEventListener("keydown", syncModifiers);
    window.removeEventListener("keyup", syncModifiers);
    window.removeEventListener("blur", clearModifiers);
    snapshot = { primary: false, alt: false };
  };
}

/**
 * 分屏和多窗口内容树可能同时挂载多个 Composer。修饰键是 window 事实，
 * 每个 Composer 各绑一套 keydown/keyup 会重复处理；这里用单一外部 store 广播瞬时状态。
 */
function subscribeDeliveryModifiers(listener: () => void): () => void {
  listeners.add(listener);
  if (!detachWindowListeners && typeof window !== "undefined") {
    detachWindowListeners = attachWindowListeners();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && detachWindowListeners) {
      detachWindowListeners();
      detachWindowListeners = null;
    }
  };
}

function getDeliveryModifiersSnapshot(): ComposerDeliveryModifiers {
  return snapshot;
}

export function useComposerDeliveryModifiers(): ComposerDeliveryModifiers {
  return useSyncExternalStore(
    subscribeDeliveryModifiers,
    getDeliveryModifiersSnapshot,
    () => snapshot,
  );
}
