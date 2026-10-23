import { describe, expect, it } from "vitest";
import type { AutoCompactPolicyConfig } from "@zcode/core";
import {
  applyPostTurnThresholdOffset,
  compactionPreferencesToPolicy,
  compactionPreferencesToPolicyOverride,
  DEFAULT_ZCODE_COMPACTION_PREFERENCES,
  getAutoCompactThreshold,
  resolveCompactionPreferencesFromSettings,
  shouldAutoCompact,
} from "../../src/context-compaction/contract.js";
import { contextCompactionModule } from "../../src/context-compaction/module.js";

describe("context-compaction contract", () => {
  it("越界或非法设置一律回落「维持现状」，不改成用户没要求过的值", () => {
    // 非法值（越界 / 非整数 / 非布尔）不得变成用户没表达过的开关或阈值。
    expect(
      resolveCompactionPreferencesFromSettings({
        compactionBufferTokens: 500,
        compactionMicrocompactKeepRecentToolResults: 999,
        compactionPostTurnThresholdOffsetTokens: -5,
        compactionMicrocompactEnabled: "yes",
      } as never),
    ).toEqual(DEFAULT_ZCODE_COMPACTION_PREFERENCES);

    expect(
      resolveCompactionPreferencesFromSettings({
        compactionBufferTokens: 20_000,
        compactionMicrocompactKeepRecentToolResults: 7,
        compactionPostTurnThresholdOffsetTokens: 3_000,
        compactionMicrocompactEnabled: true,
        compactionMicrocompactClearErrorResults: true,
        compactionPostTurnEnabled: true,
        compactionModelDownshiftEnabled: true,
      } as never),
    ).toEqual({
      bufferTokens: 20_000,
      microcompactEnabled: true,
      microcompactKeepRecentToolResults: 7,
      microcompactClearErrorResults: true,
      postTurnEnabled: true,
      postTurnThresholdOffsetTokens: 3_000,
      modelDownshiftEnabled: true,
    });
  });

  it("创建期只表达偏离默认的字段（省略键），热更新期七项全量", () => {
    // 全默认 = 用户没表达任何偏好：返回空对象，让 CLI 文件段的 compact 配置完整生效。
    expect(compactionPreferencesToPolicyOverride(DEFAULT_ZCODE_COMPACTION_PREFERENCES)).toEqual({});

    const override = compactionPreferencesToPolicyOverride({
      ...DEFAULT_ZCODE_COMPACTION_PREFERENCES,
      microcompactEnabled: true,
      postTurnThresholdOffsetTokens: 0,
    });
    expect(override).toEqual({ microcompact: { enabled: true } });
    // 0 是提前量的默认值：写进去会把 CLI 文件里的非 0 提前量覆盖掉，所以必须省略键。
    expect("postTurnThresholdOffsetTokens" in override).toBe(false);

    const policy = compactionPreferencesToPolicy(DEFAULT_ZCODE_COMPACTION_PREFERENCES);
    expect(Object.keys(policy).sort()).toEqual([
      "bufferTokens",
      "microcompact",
      "modelDownshiftEnabled",
      "postTurnEnabled",
      "postTurnThresholdOffsetTokens",
    ]);
    // bufferTokens 为 null = 显式清除覆盖，回到文件值 / 默认余量。
    expect(policy.bufferTokens).toBeNull();
    expect(policy.postTurnThresholdOffsetTokens).toBe(0);
  });

  it("提前量缺省或为 0 时轮末判定逐位不变，非 0 时按 tokens 下调阈值", () => {
    const config: AutoCompactPolicyConfig = {
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
      bufferTokens: 13_000,
    };
    // 阈值 = (窗口 − min(maxOutputTokens, 21000)) − 余量。
    expect(getAutoCompactThreshold(config)).toBe(166_000);
    // I8：偏移为 0 / 未配置原样返回**同一个引用**，不经任何单位换算往返。
    expect(applyPostTurnThresholdOffset(config, 0)).toBe(config);
    expect(applyPostTurnThresholdOffset(config, undefined)).toBe(config);
    // 越界提前量按「未配置」处理，不夹紧也不报错。
    expect(applyPostTurnThresholdOffset(config, 1_000_000)).toBe(config);

    const advanced = applyPostTurnThresholdOffset(config, 5_000);
    expect(getAutoCompactThreshold(advanced)).toBe(161_000);
    // 偏移确实接进了判定：token 落在（自动阈值 − 提前量, 自动阈值）时，轮末会压、自动不会。
    const messages = [
      { role: "user", content: "第一轮" },
      { role: "assistant", content: "回答" },
      { role: "user", content: "第二轮" },
      { role: "assistant", content: "回答" },
    ];
    const tokenOverride = { source: "provider_usage", tokenCount: 163_000 } as const;
    expect(shouldAutoCompact({ messages, config, tokenOverride }).shouldCompact).toBe(false);
    expect(shouldAutoCompact({ messages, config: advanced, tokenOverride }).shouldCompact).toBe(
      true,
    );
  });

  it("清单公开入口与契约文件一致", () => {
    expect(contextCompactionModule.id).toBe("context-compaction");
    expect(contextCompactionModule.publicEntrypoints).toContain("contract.ts");
  });
});
