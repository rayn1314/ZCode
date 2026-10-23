/**
 * api-key-preset 对外契约：调用方要想正确调用就必须知道的一切都写在这里；其余对外不可见。
 *
 * 模块意图：同一个供应商（同 baseUrl、同协议）常年有多个可用 API Key，用户不该反复手工粘贴替换。
 * 本模块提供「预存若干 Key + 一个备注名 + 一键切换」的最简机制，以及它的管理弹窗（二级形态）。
 *
 * 数据与所有权（规格：packages/provider/spec/api-key-presets.md）：
 * - 预设挂在 provider 的 `access.apiKeyPresets`，与生效 Key 同文件同层
 *   （`<数据根>/v2/provider_config.json`），唯一所有者是 personal 层 provider 配置的事务写。
 * - **切换 = 把选中预设的 `apiKey` 写进现有 `access.apiKey`**，复用既有草稿保存链
 *   （idle flush / blur flush / `savePersonalProviderOverlay`）；不新增协议命令、不新增服务方法。
 * - **没有 activePresetId 指针**：当前生效预设由「`apiKey` 与预设列表按值比对」得出
 *   （`findActiveApiKeyPreset`）；手改 Key 后自然脱选，因此不存在指针与真实 Key 走散的问题。
 * - 预设列表是**整组替换**语义（overlay 对 `apiKeyPresets` 走基类「有值=整组替换」），
 *   增删改都应把完整数组交回调用方保存；`apiKey` 与 `apiKeyPresets` 是两个独立叶子，
 *   改其中一个不隐式改另一个——手动改 Key 的补丁必须携带 `apiKeyPresets`（有测试钉死）。
 * - 仅 `isApiKeyAccess` 型 provider（`api-key` / `zhipu-coding-plan-api-key`）暴露本功能；
 *   模板层禁带预设（模板是可分发的元数据），预设也不进入 Registry（Agent 进程不可见）。
 * - 保存失败的表现与手改 Key 完全一致：`savePersonalProviderOverlay` → strict zod 校验
 *   （空名、空 Key、多余字段）→ 保存被拒、报错、既有数据不变。
 */
import type { ComponentProps } from "react";
import { ApiKeyPresetManagerDialog } from "../ApiKeyPresetManagerDialog.js";
import { ApiKeyPresetSwitcher } from "../ApiKeyPresetSwitcher.js";
import type { ApiKeyPreset } from "@/settings/model-provider-section/apiKeyPreset.js";

/**
 * 预设项形状（与 provider `access.apiKeyPresets` 元素同源）：`name`/`apiKey` 非空，
 * `id` 由 UI 用 `crypto.randomUUID()` 生成，用于稳定编辑/删除目标；定义见 `apiKeyPreset.ts`。
 */
export type { ApiKeyPreset } from "@/settings/model-provider-section/apiKeyPreset.js";

export {
  createApiKeyPreset,
  findActiveApiKeyPreset,
  maskApiKey,
} from "@/settings/model-provider-section/apiKeyPreset.js";

/** Key 下的切换行：选中预设即把它的 Key 交给 `onApply`（立即保存由调用方负责）。 */
export interface ApiKeyPresetSwitcherProps {
  presets: readonly ApiKeyPreset[];
  currentApiKey: string;
  onApply: (apiKey: string) => void;
  onManage: () => void;
}

/**
 * 管理弹窗：增删改都是「整组替换」——`onSavePresets` 收到完整数组，
 * resolve 表示已落盘；失败时调用方保持弹窗内的编辑态，不清空用户输入。
 */
export interface ApiKeyPresetManagerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  presets: readonly ApiKeyPreset[];
  currentApiKey: string;
  onApply: (apiKey: string) => void;
  onSavePresets: (presets: ApiKeyPreset[]) => Promise<void>;
}

/** 双方互相可赋值（结构等价）；元组包裹避免联合类型的分配行为。 */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

/** 编译期断言：组件真实 props 与本契约一致（改组件签名而不改契约会在这里报错）。 */
export type ApiKeyPresetSwitcherPropsMatch = Assert<
  MutuallyAssignable<ApiKeyPresetSwitcherProps, ComponentProps<typeof ApiKeyPresetSwitcher>>
>;

export type ApiKeyPresetManagerDialogPropsMatch = Assert<
  MutuallyAssignable<
    ApiKeyPresetManagerDialogProps,
    ComponentProps<typeof ApiKeyPresetManagerDialog>
  >
>;
