# 项目行「复制路径」（spec）

涉及包：`packages/ui`（菜单入口与剪贴板写入）、`packages/shared`（测试 id 常量）。

## 背景与问题

项目行「…」更多菜单此前只有远端同步、全部标为已读、移除三项。用户想把项目路径粘到终端、
编辑器或别的 App 时，只能去 header（`WorkspaceHeaderActionSection` 的 `onCopyWorkspacePath`）
或任务右键菜单里找——同一个「复制路径」在任务级和 header 级都有（`appHeader.copyPath`），
唯独侧栏项目行这个最常用的入口没有。

## 设计决策

1. **入口放在项目行「…」更多菜单**，与「全部标为已读」同一菜单：位于远端同步项之后、
   「全部标为已读」之前，让「复制」这类只读工具项与「标为已读」这类写操作分开，
   也避免紧挨最下方的破坏性「移除」。
2. **复制内容就是 `WorkspaceTabState.workspacePath`**（本地项目为绝对路径，远端项目为远端环境内的
   路径）。与 header / 任务菜单既有语义一致：「复制路径」= 项目路径，不是会话文件路径。
3. **菜单标签复用既有 `appHeader.copyPath`**，不新建同义文案；只补成功 / 失败两条反馈：
   `workspaceSidebar.copyPathDone`、`workspaceSidebar.copyPathFailed`。
   反馈必须给：`onSelect` 跑完动作菜单就收起了，剪贴板本身又没有可见结果，
   不给 toast 用户无法确认是否生效。
4. **不受 `readOnlyReason` 限制**（与同菜单的「全部标为已读」有意不同）：复制不是写操作，
   而「本地目录不可用」时这条路径反而是用户找回项目的唯一线索。
5. **不做 `document.execCommand("copy")` 兜底**：仓库内既有剪贴板写法统一只用
   `navigator.clipboard`，不可用时明确失败并提示，不引入第二套复制路径。
6. **`onSelect` 里不调 `preventDefault`，让菜单按 Radix 默认行为收起**（顺带修掉本菜单既有问题）：
   本菜单三项（复制路径 / 全部标为已读 / 移除）原先都在 `onSelect` 里 `preventDefault`，
   而 `@radix-ui/react-menu@2.1.16` 的 `MenuItem.handleSelect` 在 `itemSelectEvent.defaultPrevented`
   为真时直接跳过 `rootContext.onClose()`——等于把菜单钉住，点完必须再点一下空白处或按 Esc 才收。
   同菜单的 `RemoteSyncMenuItems`（裸 `onSelect={onOpenSkillSync}`）才是正确样例。
   去掉它不影响防点击穿透：那是各项 `onMouseDown` 的 `stopPropagation` 与 `DropdownMenuContent`
   的 `onClick` 截断负责的（该处注释写明是防行级 `CollapsibleTrigger` 抢点击）。
   注意「移除」看着本来就会关菜单，是 `closeTab` 让整行卸载的副作用；项目在运行时会先弹确认框，
   菜单其实留在确认框后面。

## 行为

| 环节         | 位置                                       | 行为                                                                                                                                              |
| ------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 菜单项       | `ui/src/WorkspaceSidebarItem.tsx` 更多菜单 | `CopyIcon` + 「复制路径」（`appHeader.copyPath`）                                                                                                 |
| 禁用条件     | 同上                                       | 仅当 `tab.workspacePath` 为空（正常项目不会命中）                                                                                                 |
| 成功         | handler                                    | `navigator.clipboard.writeText(workspacePath)` → toast「已复制路径」                                                                              |
| 剪贴板不可用 | handler                                    | 判空 `navigator.clipboard?.writeText` → toast「复制路径失败」+ `logger.warn`                                                                      |
| 写入被拒     | handler                                    | promise 第二个回调 → toast「复制路径失败」+ `logger.warn`（不向上抛）                                                                             |
| 事件隔离     | 菜单项                                     | `onMouseDown` 里 `preventDefault` + `stopPropagation`（防行级 `CollapsibleTrigger` 抢点击）；`onSelect` 不 preventDefault，点完菜单按默认行为收起 |

## 所有权与不变式

- **唯一事实源是 `WorkspaceTabState.workspacePath`**，入口只读不写：不产生状态、不发服务调用、
  不落盘、不广播，因此不存在与其它写路径竞争的可能。
- **testid 后缀沿用 `workspacePath`**（`TID_WORKSPACE_COPY_PATH`），与同菜单其它项一致；
  身份 key 规则（`workspaceIdentity?.trim() || workspacePath`）不变。
- **复制的是原样字符串**：不做 WSL / SSH 路径与宿主机路径的互转。路径形态转换只发生在
  「在文件管理器中打开」那条 `useWorkspaceOpenInEditorTarget` 链路上，复制路径不掺进去。
- **失败必须有反馈**，不允许静默返回。

## 失败语义

- **非安全上下文**（如经 http 访问的远端链路）`navigator.clipboard` 可能整个不存在：
  显式判空后提示「复制路径失败」。不判空会同步抛 `TypeError`，连提示都发不出来。
- **`writeText` reject**（权限被拒、系统剪贴板不可用）：提示失败并记 `logger.warn`，不抛给上层。
- **空路径**：菜单项禁用；handler 内二次判空仅作防御，与同菜单「全部标为已读」的写法一致。

## 迁移边界

- 不新增协议 schema、服务接口或 shared 类型；仅新增测试 id 常量 `TID_WORKSPACE_COPY_PATH`。
- 不改动 header（`WorkspaceHeaderActionSection`）与任务菜单（`TaskActionMenuContent`）既有的复制路径实现。
- 不新增「复制相对路径」「复制会话路径」等变体。

## 对应测试

本次是纯 UI 入口改动，未新增自动化用例（`packages/ui` 的测试入口在根 `pnpm test:unit`，用例放 `packages/ui/test/`）。验收路径：

1. 桌面端收起项目 →「…」→「复制路径」→ 菜单立即收起并出现「已复制路径」toast →
   到终端粘贴得到该项目绝对路径。
2. 本地目录不可用的项目（`readOnlyReason` 存在）→ 该项仍可点、能正常复制；
   对比「全部标为已读」在同一状态下禁用。
3. 同菜单「全部标为已读」「移除」点完也立即收起菜单；有运行中会话的「移除」是先关菜单再弹确认框。
4. 右键任务菜单与 header 里的复制路径行为不变。
