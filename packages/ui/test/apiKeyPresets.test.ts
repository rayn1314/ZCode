// 「API Key 预设」的数据契约（spec: packages/provider/spec/api-key-presets.md）。
//
// 钉死三件事：
// 1. 预设字段经 schema 校验（strict：空备注/空 Key/多余字段一律拒绝，不落盘）；
// 2. 模板层禁止携带预设（与「模板不得携带 Key」同一理由）；
// 3. 手改 Key 的草稿补丁必须把预设列表原样带下去，不得顺手清空。
import assert from "node:assert/strict";
import test from "node:test";
import {
  ApiKeyAccessConfig,
  isApiKeyAccess,
  parseProviderConfig,
  parseProviderTemplateMap,
} from "@zcode/provider";
import type { ProviderSettingsFormProvider } from "../src/lib/providerSettingsFormTypes.js";
import {
  resolvePendingProviderDraftSave,
  type ProviderDraftValues,
} from "../src/settings/model-provider-section/ProviderDraftSave.js";

/** 全部键值都是本地 fixture 占位串（函数生成，非任何真实凭据）。 */
const fixtureKey = (tag: string) => `fixture-key-${tag}`;

const PRESETS = [
  { id: "p-1", name: "主号", apiKey: fixtureKey("primary") },
  { id: "p-2", name: "备用", apiKey: fixtureKey("backup") },
];

function buildProvider(apiKey = fixtureKey("primary")): ProviderSettingsFormProvider {
  const access = { type: "api-key" as const, apiKey, apiKeyPresets: PRESETS };
  return {
    providerId: "p1",
    providerName: "Provider One",
    templateId: "tpl-1",
    enabled: true,
    executable: true,
    hasPersonalConfig: true,
    personalConfig: { access },
    config: {
      access,
      api: { type: "anthropic-messages" as const, baseUrl: "https://api.example.com" },
    },
    models: [],
  };
}

function buildDraft(apiKeyValue: string): ProviderDraftValues {
  return {
    nameValue: "Provider One",
    apiFormat: "anthropic-messages",
    baseUrlValue: "https://api.example.com",
    apiKeyValue,
    requestsPerMinuteValue: "",
  };
}

test("预设字段通过 schema；空备注、空 Key、多余字段被拒绝", () => {
  const parsed = parseProviderConfig({
    access: { type: "api-key", apiKeyPresets: PRESETS },
  });
  assert.ok(isApiKeyAccess(parsed.access));
  assert.deepEqual(parsed.access.apiKeyPresets, PRESETS);

  assert.throws(() =>
    parseProviderConfig({
      access: { type: "api-key", apiKeyPresets: [{ id: "x", name: "  ", apiKey: "k" }] },
    }),
  );
  assert.throws(() =>
    parseProviderConfig({
      access: { type: "api-key", apiKeyPresets: [{ id: "x", name: "n", apiKey: "" }] },
    }),
  );
  assert.throws(() =>
    parseProviderConfig({
      access: {
        type: "api-key",
        apiKeyPresets: [{ id: "x", name: "n", apiKey: "k", extra: 1 }],
      },
    }),
  );
});

test("模板层禁止携带预设：带了就解析失败，不带正常通过", () => {
  const template = (config: Record<string, unknown>) => ({
    templateId: "tpl-1",
    templateNameMap: { "zh-CN": "模板" },
    config,
  });

  assert.throws(() =>
    parseProviderTemplateMap([template({ access: { type: "api-key", apiKeyPresets: PRESETS } })]),
  );
  assert.throws(() =>
    parseProviderTemplateMap([template({ access: { type: "api-key", apiKey: "k" } })]),
  );
  assert.doesNotThrow(() => parseProviderTemplateMap([template({ access: { type: "api-key" } })]));
});

test("access overlay：不带预设字段=继承保留，带=整组替换", () => {
  const base = new ApiKeyAccessConfig({
    type: "api-key",
    apiKey: fixtureKey("base"),
    apiKeyPresets: PRESETS,
  });

  const inherited = base.overlay(new ApiKeyAccessConfig({ apiKey: fixtureKey("next") }));
  assert.deepEqual(inherited.apiKeyPresets, PRESETS);

  const replacement = [{ id: "p-3", name: "新池", apiKey: fixtureKey("three") }];
  const replaced = base.overlay(new ApiKeyAccessConfig({ apiKeyPresets: replacement }));
  assert.deepEqual(replaced.apiKeyPresets, replacement);
});

test("手改 Key 的草稿保存：预设列表在 effective 与 personal 两侧都被原样携带", () => {
  const provider = buildProvider(fixtureKey("primary"));
  const next = resolvePendingProviderDraftSave({
    provider,
    draft: buildDraft(fixtureKey("new")),
    readOnlyEndpoints: false,
    now: Date.now,
  });

  assert.ok(next, "Key 变更应产生保存");
  assert.ok(isApiKeyAccess(next.config.access));
  assert.equal(next.config.access.apiKey, fixtureKey("new"));
  assert.deepEqual(next.config.access.apiKeyPresets, PRESETS);

  assert.ok(isApiKeyAccess(next.personalConfig.access));
  assert.equal(next.personalConfig.access.apiKey, fixtureKey("new"));
  assert.deepEqual(next.personalConfig.access.apiKeyPresets, PRESETS);
});

test("Key 未变且无其它编辑时草稿保存为空：切预设落盘后不会紧跟一次空写", () => {
  const provider = buildProvider(fixtureKey("primary"));
  const next = resolvePendingProviderDraftSave({
    provider,
    draft: buildDraft(fixtureKey("primary")),
    readOnlyEndpoints: false,
    now: Date.now,
  });
  assert.equal(next, null);
});
