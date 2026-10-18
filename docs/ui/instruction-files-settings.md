# Settings 指令文件（AGENTS.md）

涉及包：`packages/ui`（本节唯一主责包）。契约类型按 `@zcode/shared` / `@zcode/services` 的冻结签名声明；服务实现不在本包。

## 问题摘要

设置页此前没有任何入口能看到或编辑 `AGENTS.md`：用户既不知道 Agent 实际读了哪个文件，也不知道超限被截断、只读或被更优先的候选遮蔽。结果是「改了文件但没生效」「以为改了却改的是另一份」。

```text
设置 · Agent 能力
  └─ 指令 (instructions)
       ├─ 用户级指令   <host home>/.zcode/AGENTS.md   对所有工作区生效
       └─ 仓库级指令   当前工作区按候选顺序命中的第一个  仅当前工作区生效，优先于用户级
```

两张卡的顺序即生效顺序，与「记忆」相邻（两者都管"上下文里放什么"）。

## 产品合同

### 分区入口

- 分区 id `instructions`，位于 `agentCapabilities` 组，紧跟「记忆」之后；图标 `FileText`，标题 `settings.instructions.title`。
- 分区不隐藏（不在 `HIDDEN_SETTINGS_SECTIONS` 内），不写入 additional 持久化状态；最近停留分区复用既有 `zcode-settings-last-section`。

### 两张卡

| 顺序 | 作用域      | 目标路径                                     | 副标题                           |
| ---- | ----------- | -------------------------------------------- | -------------------------------- |
| 1    | `user`      | `<host home>/.zcode/AGENTS.md`               | 对所有工作区生效                 |
| 2    | `workspace` | 当前工作区按候选顺序命中的第一个 `AGENTS.md` | 仅当前工作区生效，且优先于用户级 |

每张卡固定包含四段，顺序固定：

1. 头部：图标容器（`size-9 rounded-xl bg-background`）+ 标题（`h-7`）+ 副标题；远端 workspace 时用户级卡追加边注「该文件在远端机器上」。
2. 信息块（`bg-surface`）：生效行、可选被忽略行、状态行、可选只读行。
3. 操作行：`编辑`（`exists === false` 时文案为 `用模板新建`）、`用外部编辑器打开`（仅本地工作区且文件已存在）、`重新加载`；有未保存修改时追加灰色提示。
4. 编辑器（仅编辑态）：`SettingsFormTextarea` + `保存` / `取消`。

### 生效行与状态行

- 生效行固定为 `实际读取：<effectivePath>`。
- `snapshot.exists === false` 时生效路径位显示 `未创建`。
- `ignoredCandidates` 非空时，每个候选各占一行灰色次要文字：`被忽略：<路径>（已存在但未被读取）`。典型场景是仓库根 `AGENTS.md` 与 `<repo>/.zcode/AGENTS.md` 同时存在——只有前者被读取，后者必须显式列出而不是静默忽略。
- 状态行只在文件存在时渲染：字节数（`1024` 进制，`B` / `KB` / `MB`）+ `上次修改 <本地时间>`。
- `snapshot.truncated === true` 时，在状态行内追加红色徽标 `超出 100KB，Agent 只读前 100KB`。这是真实生效语义，不允许只写在文档里。
- `snapshot.writable === false` 时在信息块追加只读行，展示 `readonlyReason`（缺失时用兜底文案）。

### 编辑态

- `编辑` 展开内联编辑器（不再有独立弹窗/独立页面）：等宽字体、`min-h-[240px]`、`aria-label` 为 `<作用域标题>内容编辑框`。
- 底部 `保存`（主）+ `取消`（次）。内容与已加载内容一致时 `保存` 禁用；`saving` 时 `保存` 转 loading 且编辑器禁用。
- `writable === false`：编辑器 `readOnly`（保留可选中/可复制），`保存` 禁用，只读行展示原因——不伪装可写。
- 编辑态下 `编辑` 按钮失活：编辑器已展开，重复点击会重置草稿。
- 新建态（`exists === false`）：主按钮为 `用模板新建`，模板是骨架而非猜测内容：

  ```markdown
  # 工作区概览

  ## 常用命令

  ## 代码约定

  ## 验收方式
  ```

  四点来自 i18n，写入后即成为真实草稿，因此可立即保存创建文件；`expectedMtimeMs` 传 `null`。

### 状态矩阵

| 状态                | 渲染                                                   |
| ------------------- | ------------------------------------------------------ |
| 加载中 / 连接未就绪 | 信息块位置渲染骨架（`aria-busy`），操作行按钮全部禁用  |
| 空（未创建）        | 生效行 `未创建`，主按钮 `用模板新建`                   |
| 正常                | 生效行 + 状态行，主按钮 `编辑`                         |
| 超出 100KB          | 正常态 + 红色截断徽标；仍可编辑并保存                  |
| 只读                | 只读行 + 编辑器 `readOnly` + `保存` 禁用               |
| 保存冲突            | 阻塞式确认对话框三选一（见下），草稿保持不动           |
| 保存失败            | 草稿不丢 + toast + 卡片内可操作错误行（带 `重新加载`） |
| 服务未注入          | 按加载失败渲染，提示服务不可用，不伪造 `未创建`        |
| 远端工作区          | 用户级卡加边注；两张卡都不渲染 `用外部编辑器打开`      |
| Web Remote / 手机   | 只显示「前往桌面端管理」提示，零服务调用               |
| 无工作区            | 只显示空态提示，零服务调用                             |

### 冲突确认对话框

磁盘文件在读取后被外部修改时，`writeInstructionFile` 返回 `{ ok: false, reason: "conflict" }`。这不是失败，而是并发事实，必须由用户裁决：

| 动作                     | 语义                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| `覆盖磁盘内容`           | 先重新读取磁盘当前版本（接受其 mtime 作为新的并发基线），再用基线提交草稿；再次冲突则重新弹窗 |
| `放弃我的修改并重新加载` | 真的重新拉取，并用磁盘内容替换草稿；拉取失败时保留草稿，不静默丢弃                            |
| `取消`                   | 关闭对话框，草稿与编辑态原样保留                                                              |

对话框用 `AlertDialog`（Radix）：焦点陷阱、Esc 取消、点击遮罩不关闭——误关会让人以为改动已处理。三个分支都是显式按钮，不使用 `AlertDialogAction` / `Cancel` 的自动关闭。

## 状态与事件

```text
snapshot（磁盘事实，只由读取写入）
  ├─ load() ────────────────────────────────> 渲染生效行 / 状态行
  └─ reloadSnapshot()（silent）─────────────> 同上，不动草稿

draft（未保存内容，唯一载体）
  ├─ startEdit()                             ──> draft = 磁盘内容 | 模板骨架
  ├─ setDraftValue(text)                     ──> draft 更新
  ├─ cancelEdit()                            ──> draft = null
  └─ saveDraft() / resolveConflict*()
       ├─ { ok: true }                       ──> draft = null + silent reload
       ├─ { reason: "conflict" }             ──> conflictOpen = true（草稿不动）
       └─ { reason: "not-writable"|"failed" }──> saveError + toast（草稿不动）
```

不变式：

- 草稿是「未保存内容」的唯一载体；任何读取（含保存成功的刷新、冲突裁决的刷新）都只更新 `snapshot`，绝不静默覆盖草稿。
- 冲突判定由服务端独占（`expectedMtimeMs` 是唯一并发令牌），UI 不自行比较 mtime、不做本地乐观判定。
- 两张卡各自持有独立的 `snapshot` / `draft` / `saving`，不共享、不联动；服务解析只做一次并同时注入两张卡，保证同一 workspace 不会出现两种读取结果。
- 保存与写入全部经 services 层（`instructionsService`），Renderer 不拼接路径、不读文件、不写文件。

## 平台与架构边界

- 服务经 `useWorkspaceServicesResolution(workspacePath, undefined, workspaceIdentity)` 解析当前工作区所属 host：本地工作区落到 base host，远端 workspace 落到远端 host。指令文件的读写永远发生在文件真正所在的机器。
- `resolveInstructionsService` 是本页唯一服务注入点：按运行时形状校验解析 `instructionsService`，缺失（旧 host / 服务未落地）时返回 `null` 并按加载失败渲染，不抛异常、不伪造空文件。服务落地后该函数改为直接引用 `@zcode/shared` / `@zcode/services` 类型即可，调用处不变。
- `用外部编辑器打开` 仅本地工作区渲染，复用 `WorkspaceEditorButtonGroup`；远端 workspace 隐藏该项，避免给出指向错误机器的假入口。
- Web Remote / 手机：`fileManagementAvailable` 为 false 时直接返回提示组件，不挂 `useWorkspaceServicesResolution`，不发起任何 RPC（与 Memory 页的边界一致）。
- 无工作区时不发起任何调用：冻结契约的读写均要求 `workspacePath`，因此用户级也无法管理，统一给空态而不是半张卡。
- 不新增协议、watcher、轮询、导出、删除能力；不缓存文件内容，不把磁盘事实写进 setting / localStorage / Host。

## 响应式与无障碍

- 桌面与手机宽度使用相同的信息架构：头部 / 信息块 / 操作行 / 编辑器自上而下，窄屏只换行不改变语义。
- 滚动由 Settings 主内容区统一承担，卡片内不建第二条滚动条，不使用固定卡片头部。
- 操作行按钮使用原生按钮语义；`重新加载` 有独立可访问名称；编辑器带 `aria-label`；截断徽标与只读行都是文本而非仅颜色。
- 生效路径与被忽略路径允许截断，完整路径通过 `title` 提供，不新增装饰性动画。
- 所有文案走 i18n（`settings.instructions.*`），颜色、字号、间距、圆角使用 `DESIGN.md` 语义 token。

## 验收用例

| ID    | Setup                                             | Action       | Assertions                                                                            |
| ----- | ------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------- |
| INS01 | 用户级与仓库级都存在                              | 打开「指令」 | 两张卡按生效顺序排列；生效行显示各自路径；状态行显示字节数与修改时间                  |
| INS02 | 仓库根 `AGENTS.md` 与 `.zcode/AGENTS.md` 同时存在 | 打开「指令」 | 生效行只有仓库根；`.zcode/AGENTS.md` 出现在「被忽略」行                               |
| INS03 | 只有 `.zcode/AGENTS.md`                           | 打开「指令」 | 生效行是该路径，没有被忽略行                                                          |
| INS04 | 两级都不存在                                      | 点主按钮     | 生效行 `未创建`；主按钮 `用模板新建`；编辑器填入四点骨架且可保存                      |
| INS05 | 用户级 120KB                                      | 打开「指令」 | 红色徽标「超出 100KB，Agent 只读前 100KB」；编辑器仍可编辑、保存可用                  |
| INS06 | 磁盘在编辑期间被外部修改                          | 保存         | 阻塞式三选一对话框；`放弃…并重新加载` 后草稿真的变成磁盘内容；`覆盖…` 用新 mtime 提交 |
| INS07 | 文件 `writable:false`                             | 打开编辑     | 编辑器只读、保存禁用、展示 `readonlyReason`                                           |
| INS08 | 写入返回 `failed`                                 | 保存         | 草稿不丢 + toast + 卡片内错误行带 `重新加载`                                          |
| INS09 | 远端 workspace                                    | 打开「指令」 | 用户级卡有「该文件在远端机器上」边注；两张卡都没有外部编辑器入口                      |
| INS10 | Web Remote / 手机                                 | 打开「指令」 | 只显示「前往桌面端管理」提示；`readInstructionFile` 零调用                            |
| INS11 | 未打开工作区                                      | 打开「指令」 | 只显示空态提示；零调用                                                                |
| INS12 | 连接未就绪                                        | 打开「指令」 | 骨架 + `aria-busy`；编辑与重新加载禁用；零调用                                        |

## 剪枝

- 不枚举 Runtime、provider、desktop continuous 与 mobile replayable 消息组合：本改动不触发 Runtime 或协议，只用「零调用」不变量证明隔离。
- 不新增文件系统等价类（目录 containment、symlink、并发删除、原子写入、100KB 上限）：这些由指令文件服务自身的测试覆盖，UI 只消费快照与写入结果。
- 不保留「独立编辑弹窗 / 独立页面」形态的用例：内联编辑是本轮唯一编辑形态。
- 不覆盖 `WorkspaceEditorButtonGroup` 的编辑器选择行为：它由既有工作区头部入口的用例覆盖。
