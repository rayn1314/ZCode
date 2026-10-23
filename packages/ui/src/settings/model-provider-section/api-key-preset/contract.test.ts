import { describe, expect, it } from "vitest";

import {
  createApiKeyPreset,
  findActiveApiKeyPreset,
  maskApiKey,
  type ApiKeyPreset,
} from "@/settings/model-provider-section/apiKeyPreset.js";

// 契约测试钉死 spec（packages/provider/spec/api-key-presets.md）里的三条纯逻辑不变量：
// 掩码只露尾 4 位、当前生效预设靠按值比对得出（无指针）、预设项 id 稳定且名称/Key 去空白。

function preset(id: string, name: string, apiKey: string): ApiKeyPreset {
  return { id, name, apiKey };
}

describe("api-key-preset 展示口径", () => {
  it("掩码只露尾 4 位，短 Key 不泄露长度细节", () => {
    expect(maskApiKey("sk-abcdefghijklmnop-9f3c")).toBe("····9f3c");
    expect(maskApiKey("  sk-abcdefghijklmnop-9f3c  ")).toBe("····9f3c");
    expect(maskApiKey("abcd")).toBe("····");
    expect(maskApiKey("abc")).toBe("····");
  });

  it("当前生效预设按值比对；手改 Key 后自然脱选，不引入独立指针", () => {
    const presets = [preset("p1", "官方", "key-official"), preset("p2", "中转", "key-relay")];

    expect(findActiveApiKeyPreset(presets, "key-relay")?.id).toBe("p2");
    // 生效 Key 被手改：没有任何预设匹配，界面显示「自定义 Key」。
    expect(findActiveApiKeyPreset(presets, "key-official-edited")).toBeUndefined();
    expect(findActiveApiKeyPreset(presets, "")).toBeUndefined();
    // 两个预设恰好同 Key 时按列表顺序命中第一个，结果稳定。
    const duplicated = [preset("p1", "A", "same"), preset("p2", "B", "same")];
    expect(findActiveApiKeyPreset(duplicated, "same")?.id).toBe("p1");
  });
});

describe("api-key-preset 新建口径", () => {
  it("名称与 Key 去空白，生成可稳定引用项", () => {
    const created = createApiKeyPreset("  官方  ", "  sk-abcdefghijklmnop-9f3c  ");

    expect(created.name).toBe("官方");
    expect(created.apiKey).toBe("sk-abcdefghijklmnop-9f3c");
    expect(created.id.length).toBeGreaterThan(0);
    // id 用于稳定编辑/删除目标：两次新建不会撞 id。
    expect(createApiKeyPreset("官方", "sk-other").id).not.toBe(created.id);
  });
});
