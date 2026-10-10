// 插件清单 userConfig 的 options 契约（P0 回归）：
//
// Anthropic 的 code-modernization 1.0.0 把 userConfig.track / userConfig.panel 从「自由文本」升级为
// 「枚举 + options 候选」。ZCode 侧 zcodePluginInfoSchema.userConfig 用 .strict()，不认识 options 时
// 抛出 unrecognized_keys —— 报错面是整个插件列表（plugins[i].userConfig.<key>），一个插件就能让
// 市场页与安装流程全挂。本文件钉住三件事：
//   1. 声明 options 的清单必须解析通过（回归本轮线上故障）；
//   2. options 的元素仍受 string|number|boolean 约束，不是把 strict 放宽成 passthrough；
//   3. userConfig 里仍然拒绝未知键（避免用「允许一切」的方式糊过去）。
import assert from "node:assert/strict";
import test from "node:test";
import {
  zcodePluginInfoSchema,
  zcodePluginsListResultSchema,
} from "../src/zcode-protocol/index.js";

function basePlugin(userConfig: unknown) {
  return {
    id: "code-modernization@claude-plugins-official",
    name: "code-modernization",
    enabled: true,
    source: "./plugins/code-modernization",
    marketplace: "claude-plugins-official",
    skillRootCount: 1,
    commandRootCount: 1,
    mcpServerNames: [],
    rootPath: "/tmp/plugins/code-modernization",
    userConfig,
  };
}

test("userConfig 声明 options 时插件信息可解析（track/panel 回归）", () => {
  const parsed = zcodePluginInfoSchema.safeParse(
    basePlugin({
      track: {
        type: "string",
        title: "Track to follow",
        default: "auto",
        options: ["auto", "transform", "uplift", "reimagine"],
      },
      panel: { type: "string", default: "auto", options: ["auto", "command", "off"] },
      xray: { type: "boolean", default: true },
    }),
  );
  assert.equal(parsed.success, true, JSON.stringify(parsed.success ? null : parsed.error.issues));
  assert.deepEqual(parsed.data?.userConfig?.track.options, [
    "auto",
    "transform",
    "uplift",
    "reimagine",
  ]);
});

test("插件列表结果里的 options 同样解析通过", () => {
  const parsed = zcodePluginsListResultSchema.safeParse({
    plugins: [
      basePlugin({ track: { type: "string", default: "auto", options: ["auto", "transform"] } }),
    ],
    diagnostics: [],
  });
  assert.equal(parsed.success, true, JSON.stringify(parsed.success ? null : parsed.error.issues));
});

test("options 元素只接受 string | number | boolean", () => {
  const parsed = zcodePluginInfoSchema.safeParse(
    basePlugin({ track: { type: "string", options: [{ label: "auto" }] } }),
  );
  assert.equal(parsed.success, false, "对象候选项应被拒");
});

test("userConfig 未知键仍然被拒（strict 未放宽）", () => {
  const parsed = zcodePluginInfoSchema.safeParse(
    basePlugin({ track: { type: "string", futureField: true } }),
  );
  assert.equal(parsed.success, false, "userConfig 内的未知键应仍被拒");
});
