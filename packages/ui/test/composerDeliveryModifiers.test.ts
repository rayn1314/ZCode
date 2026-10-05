// composer per-send 投递契约：修饰键固定映射（⌘/Ctrl=立即、⌥=插队引导）与三态 tooltip。
// spec: packages/ui/spec/composer-per-send-delivery.md
import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveDeliveryForModifiers,
  resolveFollowupModifierTooltip,
  resolvePointerDelivery,
  shouldEnableModifiedEnterSubmit,
} from "../src/v4/composer/followupModeSettings.js";

test("修饰键固定映射：⌘/Ctrl 恒为 startNow，⌥ 仅 busy 时为 guide", () => {
  assert.equal(resolveDeliveryForModifiers({ primary: true, alt: false, busy: true }), "startNow");
  // 空闲时 ⌘/Ctrl 仍传 startNow：CLI 对 idle 输入本就按新 turn 处理，语义等价。
  assert.equal(resolveDeliveryForModifiers({ primary: true, alt: false, busy: false }), "startNow");
  assert.equal(resolveDeliveryForModifiers({ primary: false, alt: true, busy: true }), "guide");
  // guide 只在有 active turn 时有意义，空闲不产生 guide。
  assert.equal(resolveDeliveryForModifiers({ primary: false, alt: true, busy: false }), undefined);
  assert.equal(resolveDeliveryForModifiers({ primary: false, alt: false, busy: true }), undefined);
  // 双键同按定死 startNow 优先，避免歧义。
  assert.equal(resolveDeliveryForModifiers({ primary: true, alt: true, busy: true }), "startNow");
});

test("指针路径：修饰键经平台判定解析为投递模式，enabled 关闭时一律 undefined", () => {
  // Apple 平台 primary=metaKey，其他平台 primary=ctrlKey；altKey 独立于平台。
  assert.equal(
    resolvePointerDelivery({
      enabled: true,
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      busy: true,
      isApplePlatform: true,
    }),
    "startNow",
  );
  assert.equal(
    resolvePointerDelivery({
      enabled: true,
      metaKey: false,
      ctrlKey: true,
      altKey: false,
      busy: true,
      isApplePlatform: false,
    }),
    "startNow",
  );
  assert.equal(
    resolvePointerDelivery({
      enabled: true,
      metaKey: false,
      ctrlKey: false,
      altKey: true,
      busy: true,
      isApplePlatform: false,
    }),
    "guide",
  );
  assert.equal(
    resolvePointerDelivery({ enabled: false, metaKey: true, ctrlKey: true, busy: true }),
    undefined,
  );
});

test("修饰键 tooltip：⌘/Ctrl 显立即、⌥ 显引导，未按住或不可发送时不显", () => {
  const apple = true;
  const sendNow = resolveFollowupModifierTooltip({
    enabled: true,
    canSend: true,
    primaryPressed: true,
    altPressed: false,
    isApplePlatform: apple,
  });
  assert.deepEqual(sendNow, {
    delivery: "startNow",
    shortcut: "⌘ + Enter",
    titleId: "chat.followup.sendNow",
  });
  const guide = resolveFollowupModifierTooltip({
    enabled: true,
    canSend: true,
    primaryPressed: false,
    altPressed: true,
    isApplePlatform: false,
  });
  assert.deepEqual(guide, {
    delivery: "guide",
    shortcut: "Alt + Enter",
    titleId: "chat.followup.guideCurrent",
  });
  assert.equal(
    resolveFollowupModifierTooltip({
      enabled: true,
      canSend: true,
      primaryPressed: false,
      altPressed: false,
      isApplePlatform: apple,
    }),
    null,
  );
  assert.equal(
    resolveFollowupModifierTooltip({
      enabled: false,
      canSend: true,
      primaryPressed: true,
      altPressed: false,
      isApplePlatform: apple,
    }),
    null,
  );
  assert.equal(
    resolveFollowupModifierTooltip({
      enabled: true,
      canSend: false,
      primaryPressed: true,
      altPressed: false,
      isApplePlatform: apple,
    }),
    null,
  );
});

test("modified enter 门禁：仅 reject 路由禁用组合键提交", () => {
  assert.equal(shouldEnableModifiedEnterSubmit({ inputRoutingMode: "reject" }), false);
  assert.equal(shouldEnableModifiedEnterSubmit({ inputRoutingMode: "guide" }), true);
  assert.equal(shouldEnableModifiedEnterSubmit({ inputRoutingMode: "enqueue" }), true);
  assert.equal(shouldEnableModifiedEnterSubmit({ inputRoutingMode: "choice" }), true);
});
