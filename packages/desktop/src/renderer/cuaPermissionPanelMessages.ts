import { ZCODE_PRODUCT_NAME, type CuaPermissionKind, type Locale } from "@zcode/shared";

// 面板窗口标题里的 {appName} 取自构建期产品身份，与主窗口标题、托盘提示用同一份值。
// 未经 tsup/vite 注入的构建路径（例如直接跑单测）拿不到常量，回退到上游默认名。
const PANEL_APP_NAME = ZCODE_PRODUCT_NAME || "ZCode";

interface CuaPermissionPanelMessages {
  documentTitle: string;
  dragTitle: string;
  hintPrefix: string;
  permissionLabel: string;
  hintSuffix: string;
  completion: string;
}

const MESSAGES: Record<
  Locale,
  Omit<CuaPermissionPanelMessages, "permissionLabel"> & Record<CuaPermissionKind, string>
> = {
  "zh-CN": {
    documentTitle: "{appName} Computer Use 权限",
    dragTitle: "拖动我到上面的权限列表",
    hintPrefix: "把左边的图标拖进上方的",
    hintSuffix: "列表",
    completion: "松手即完成授权，无需再点开关",
    accessibility: "辅助功能",
    screen_recording: "屏幕录制",
  },
  "en-US": {
    documentTitle: "{appName} Computer Use Permissions",
    dragTitle: "Drag me to the permission list above",
    hintPrefix: "Drag the icon on the left into the ",
    hintSuffix: " list above",
    completion: "Release to grant access—no need to toggle the switch",
    accessibility: "Accessibility",
    screen_recording: "Screen Recording",
  },
};

export function resolveCuaPermissionPanelMessages(
  locale: Locale,
  permission: CuaPermissionKind,
): CuaPermissionPanelMessages {
  const messages = MESSAGES[locale];
  return {
    documentTitle: messages.documentTitle.replaceAll("{appName}", PANEL_APP_NAME),
    dragTitle: messages.dragTitle,
    hintPrefix: messages.hintPrefix,
    permissionLabel: messages[permission],
    hintSuffix: messages.hintSuffix,
    completion: messages.completion,
  };
}
