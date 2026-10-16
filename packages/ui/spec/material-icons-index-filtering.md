# 文件图标对未知扩展名不再发起注定失败的请求（spec）

涉及包：`packages/ui`（`fileDisplayHelpers.ts` / `fileDisplay.tsx` 过滤逻辑与测试）、
`scripts`（新增共享 vite 插件 `material-icons-index-plugin.mjs`）、`packages/desktop` 与
`packages/web`（各自 vite config 接入插件注入素材清单）。

## 背景与问题

文件图标按扩展名拼 `material-icons/<name>.svg` 请求素材。`resolveIconName` 对未知扩展名
（如 `.text`、`.ipynb`、`.tfvars`）的兜底是**直接返回扩展名本身**，于是每次渲染这类文件都会
发起一个注定失败的请求：打包版在 `file://` 下控制台持续刷
`Failed to load resource: net::ERR_FILE_NOT_FOUND`（实测 `text.svg:1`）。随后组件 `onError`
才兜底换成 `document.svg`——图标显示正常，但每个未知扩展名文件、每次列表刷新都留下一条
失败请求，控制台噪音长期存在。

## 设计决策

1. **素材清单在构建期注入为编译期常量**：共享插件 `materialIconsIndexPlugin({ iconsDir })`
   扫描各端 `public/material-icons/`，把实际存在的素材文件名（去 `.svg`）序列化进
   `define.__MATERIAL_ICONS_INDEX__`。desktop（`src/renderer/public/material-icons`）与 web
   （`public/material-icons`）各挂一次，素材与代码在构建时天然同步，不引入运行时 fetch。
2. **过滤收敛在 `buildMaterialFileIconSrc` 唯一出口**：该函数是全部图标路径的单一出口
   （`FOLDER_FILE_ICON_SRC` / `DOCUMENT_FILE_ICON_SRC` / `buildIconSrc` 都经它）。素材清单里
   不存在的名字在此回退 `document`，**压根不发注定失败的请求**；`onError` 二级兜底保留，
   只作为清单缺失时的最后防线。
3. **纯函数可测**：回退判定抽成 `resolveAvailableMaterialIconName(iconName, knownIconNames)`，
   `getKnownMaterialIconNames()` 惰性把全局清单转 `Set` 并缓存。
4. **未注入环境保守放行**：ui 包独立 typecheck / 单测 / 未接入插件的构建没有
   `__MATERIAL_ICONS_INDEX__`（`typeof` 恒为 `"undefined"`），此时保持原行为——不因清单缺失
   让图标全部退化成 document。
5. **`document` 恒放行**：它是回退链底座，即使清单里没有也必须可用；插件同时守护
   `document.svg` / `folder.svg` 存在，素材被误删时构建期直接报错。

## 行为

| 环节     | 位置                                      | 行为                                                                                    |
| -------- | ----------------------------------------- | --------------------------------------------------------------------------------------- |
| 清单注入 | `scripts/material-icons-index-plugin.mjs` | 构建期读 `iconsDir`，`define.__MATERIAL_ICONS_INDEX__` 注入素材名数组；缺回退资源时抛错 |
| 桌面接入 | `packages/desktop/vite.config.ts` plugins | `materialIconsIndexPlugin({ iconsDir: src/renderer/public/material-icons })`            |
| Web 接入 | `packages/web/vite.config.ts` plugins     | `materialIconsIndexPlugin({ iconsDir: public/material-icons })`                         |
| 回退判定 | `ui/src/lib/fileDisplayHelpers.ts`        | `resolveAvailableMaterialIconName`：未知/缺失名字 → `document`；`document` 恒放行       |
| 清单缓存 | `ui/src/lib/fileDisplayHelpers.ts`        | `getKnownMaterialIconNames()`：首次调用建 `Set` 并缓存（undefined 区分未注入与空集合）  |
| 出口收敛 | `ui/src/lib/fileDisplay.tsx`              | `buildMaterialFileIconSrc` 先过滤再拼路径                                               |

## 所有权与不变式

- **`buildMaterialFileIconSrc` 是图标路径唯一出口**：任何新增的图标资源引用都必须经它，
  过滤才会生效；绕过它直接拼 `material-icons/...` 的代码视为回归。
- **素材清单与素材目录同一构建期同步**：新增/删除素材只需重新构建，define 自动更新，
  无手动维护的第二份清单。
- **`document` / `folder` 是回退链底座**：插件在构建期校验两者存在；运行期
  `resolveAvailableMaterialIconName` 对 `document` 无条件放行。
- **过滤只发生在路径出口**：`resolveIconName` 仍返回扩展名本身（如 `text`），供
  `getIconLabel` 等派生逻辑使用，不被过滤污染。

## 失败语义

- 素材目录缺失 / 缺 `document.svg` / `folder.svg`：插件工厂抛错，构建显性失败——配置错误
  应尽早暴露，不静默退化。
- 构建未注入 `__MATERIAL_ICONS_INDEX__`（独立 typecheck、单测、未接入插件的构建）：
  `getKnownMaterialIconNames()` 返回 `null`，`resolveAvailableMaterialIconName` 原样放行，
  行为与改动前完全一致。
- 单个素材文件意外丢失但构建仍成功（清单已生成）：该名字不在清单 → 回退 `document`，
  不会出现破图（原 `onError` 兜底仍作为第二道防线保留）。

## 迁移边界

- 不新增协议字段、不改变 `resolveIconName` 返回值、不改 `onError` 兜底链；`FOLDER_FILE_ICON_SRC`
  等常量输出在注入清单后与先前一致（`folder` / `document` 均在清单内）。
- desktop 与 web 各自接入插件；其它未来消费端接入方式与 web 相同（指向自己的素材目录）。
- 本次只消除「注定失败的请求」；素材目录本身是否补齐更多图标属于素材库演进，不在此范围。

## 对应测试

- `packages/ui/src/lib/fileDisplayHelpers.test.ts`：`resolveAvailableMaterialIconName` 四分支
  （未注入放行 / 清单命中 / document 恒放行 / 缺失回退）；`getKnownMaterialIconNames` 未注入
  返回 `null`、注入后返回 `Set`（`vi.resetModules` 隔离缓存）；`resolveIconName` 既有解析
  行为不变。
