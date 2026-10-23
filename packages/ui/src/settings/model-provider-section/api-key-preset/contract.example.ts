/**
 * api-key-preset 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 *
 * 三段真实用法：
 * 1. 切换行/管理弹窗要的展示值：掩码与「当前生效预设」的按值比对。
 * 2. 切换行 props：`onApply` 只写生效 Key，`onManage` 开二级弹窗。
 * 3. 新增/删除预设 = 整组替换后交给调用方保存（复用既有 Key 保存链）。
 */
import {
  createApiKeyPreset,
  findActiveApiKeyPreset,
  maskApiKey,
  type ApiKeyPreset,
  type ApiKeyPresetSwitcherProps,
} from "./contract.js";

/** 下拉与列表展示：只露尾 4 位；`activePreset` 无匹配即「自定义 Key」（手改过 Key）。 */
export function presetDisplayExample(
  presets: readonly ApiKeyPreset[],
  currentApiKey: string,
): { activePresetId: string | null; options: Array<{ id: string; label: string }> } {
  const active = findActiveApiKeyPreset(presets, currentApiKey);
  return {
    activePresetId: active?.id ?? null,
    options: presets.map((preset) => ({
      id: preset.id,
      label: `${preset.name} ${maskApiKey(preset.apiKey)}`,
    })),
  };
}

/** 切换行 props：应用回调由调用方实现为「写生效 Key + 立即保存」。 */
export function switcherPropsExample(
  presets: readonly ApiKeyPreset[],
  currentApiKey: string,
  saveApiKey: (apiKey: string) => void,
  openManager: () => void,
): ApiKeyPresetSwitcherProps {
  return { presets, currentApiKey, onApply: saveApiKey, onManage: openManager };
}

/** 新增预设：整组替换后保存；删除只是把目标 id `filter` 掉，同样整组回写。 */
export async function addPresetExample(
  presets: readonly ApiKeyPreset[],
  name: string,
  apiKey: string,
  savePresets: (next: ApiKeyPreset[]) => Promise<void>,
): Promise<ApiKeyPreset[]> {
  const next = [...presets, createApiKeyPreset(name, apiKey)];
  await savePresets(next);
  return next;
}
