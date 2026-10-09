// 授权超时自动拒绝开关在 shared 层的兼容契约（spec：
// apps/zcode-cli/packages/bootstrap/spec/permission-request-timeout.md）。
//
// 这个开关默认**开启**，所以"缺字段"的语义方向与常见的默认关闭项相反，容易写反：
//   * 缺字段一律解析成 `true`（= 产品默认），旧 Host / 旧配置不会把它误关掉；
//   * 显式 `false` 必须原样保留，否则用户关不掉这个安全网；
//   * Host → CLI 的命令字段必须是 optional——新 CLI 要能吃下旧 Host 发来的命令，
//     否则旧 Host 一握手就报 Invalid params，整个会话起不来。
import assert from "node:assert/strict";
import test from "node:test";
import { appRuntimePreferencesChangedBroadcastPayloadSchema } from "../src/app-runtime-preferences.js";
import { appSettingsPatchSchema, appSettingsSchema } from "../src/validationAppSettings.js";
import {
  zcodeInteractionPreferencesSchema,
  zcodeSessionRuntimePreferencesResultSchema,
} from "../src/zcode-protocol/index.js";

const HANDSHAKE_BASE = {
  askUserQuestionAutoResolutionEnabled: true,
  nativeSearchEnhancementsEnabled: false,
};

test("AppSettings 缺字段按默认开启，显式关闭原样保留", () => {
  assert.equal(appSettingsSchema.parse({}).permissionRequestAutoDenyEnabled, true);
  assert.equal(
    appSettingsSchema.parse({ permissionRequestAutoDenyEnabled: false })
      .permissionRequestAutoDenyEnabled,
    false,
  );
});

test("patch 只接受布尔；缺字段表示「不改」，不是「改成默认」", () => {
  assert.equal(
    appSettingsPatchSchema.safeParse({ permissionRequestAutoDenyEnabled: false }).success,
    true,
  );
  assert.equal(appSettingsPatchSchema.safeParse({}).success, true);
  for (const wrong of ["true", 1, null]) {
    assert.equal(
      appSettingsPatchSchema.safeParse({ permissionRequestAutoDenyEnabled: wrong }).success,
      false,
      `应拒绝 permissionRequestAutoDenyEnabled=${String(wrong)}`,
    );
  }
});

test("Host → CLI 的偏好命令：旧 Host 不带该字段也必须合法", () => {
  // 这就是"新 CLI 遇旧 Host"的形态——去掉这一行就会在用户那里炸成 Invalid params。
  assert.equal(
    zcodeInteractionPreferencesSchema.safeParse({
      askUserQuestionAutoResolutionEnabled: true,
    }).success,
    true,
  );
  assert.equal(
    zcodeInteractionPreferencesSchema.safeParse({
      askUserQuestionAutoResolutionEnabled: true,
      permissionRequestAutoDenyEnabled: false,
    }).success,
    true,
  );
  assert.equal(
    zcodeInteractionPreferencesSchema.safeParse({
      askUserQuestionAutoResolutionEnabled: true,
      permissionRequestAutoDenyEnabled: 0,
    }).success,
    false,
  );
});

test("握手结果：缺字段按开启，显式关闭时真的关掉", () => {
  const missing = zcodeSessionRuntimePreferencesResultSchema.parse(HANDSHAKE_BASE);
  assert.equal(missing.permissionRequestAutoDenyEnabled, true);

  const off = zcodeSessionRuntimePreferencesResultSchema.parse({
    ...HANDSHAKE_BASE,
    permissionRequestAutoDenyEnabled: false,
  });
  assert.equal(off.permissionRequestAutoDenyEnabled, false);
});

test("跨窗口广播：缺字段按开启，显式关闭原样保留", () => {
  const missing = appRuntimePreferencesChangedBroadcastPayloadSchema.parse({
    askUserQuestionAutoResolutionEnabled: true,
  });
  assert.equal(missing.permissionRequestAutoDenyEnabled, true);

  const off = appRuntimePreferencesChangedBroadcastPayloadSchema.parse({
    askUserQuestionAutoResolutionEnabled: true,
    permissionRequestAutoDenyEnabled: false,
  });
  assert.equal(off.permissionRequestAutoDenyEnabled, false);
});
