# Gen UI 跨执行端渲染失败治理（spec）

涉及包：`packages/services`（主责：gen-ui 服务、读取越界校验、渲染失败报告接口）、`packages/shared`（协议 schema 新增）、
`apps/zcode-cli`（bootstrap 操作接入 + core 轮次上下文注入 section）、`packages/ui`（服务路由不变式的消费方与失败日志）、
`packages/desktop`（host 转发透传）。

## 背景与问题

Gen UI（交互视图）允许模型在回复里以 `::visualize` 指令引用一个 HTML 片段，桌面端将其内联渲染。
宿主读取文件前做越界校验：`readGenUiDocument`（`packages/services/src/gen-ui/adapters/files.ts:22-31`）要求
被引用的绝对路径落在执行端 Host 的固定输出根 `outputRoot`（`getAppConfigDir()/visualizations`）之内，
`path.relative(root, file)` 落出根即抛 `Gen UI file is outside the host output directory`。

两个已确认的问题叠加，使该报错在跨执行端（桌面 Windows ↔ WSL/远端）场景下表现为「模型一用就报、报了模型还不知道」：

### 问题一：写端与读端的 outputRoot 结构上不同根（已确认，实测 2026-10-15）

`outputRoot` 由**各自进程**的 `getAppConfigDir()` 推导（`packages/services/src/paths.ts:152` → `getZCodeDataRootDir()`），跨机器/跨文件系统时必然不同：

| 进程            | 实测 outputRoot                                                                          | 规模                         |
| --------------- | ---------------------------------------------------------------------------------------- | ---------------------------- |
| 桌面（Windows） | `C:\Users\rayn\.zcode-rayn\v2\visualizations`                                            | 60+ 会话目录                 |
| WSL 执行端      | `/home/rayn/.zcode-rayn/v2/visualizations`（`ZCODE_DATA_ROOT` 未设，取 `~/.zcode-rayn`） | **303** 会话目录（活跃写端） |

判定探针（`E:\Temp\zcode-genui-path-probe.mjs` / `.py`，逐条复现 `files.ts` 的 `isAbsolute` + `relative` 逻辑）：

| 模型引用的 path 形态                                          | Windows 读端                                                 | WSL(Linux) 读端                              |
| ------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------- |
| 注入的 POSIX 根 `/home/rayn/.../visualizations/<hash>/x.html` | **越界 → 本报错**（Windows 把 `/` 开头判为盘符相对绝对路径） | ✅ 同根可读（唯一通路）                      |
| UNC `\\wsl.localhost\Ubuntu\...`                              | 越界 → 本报错                                                | `isAbsolute=false` → `Invalid executor path` |
| WSL 项目目录 `/home/rayn/project/x.html`                      | 越界 → 本报错                                                | 越界 → 本报错                                |
| 本机 `C:\Users\...` 注入目录                                  | ✅ 同根                                                      | `isAbsolute=false` → `Invalid executor path` |

链路事实（代码已核）：

- 远端 server（WSL supervisor 部署的 bundle）**已注册** `IGenUiService`（`zcode-server.cjs` 容器组装含 `createGenUiService`），其 `outputRoot` 与 spawn Agent 时注入的 `ZCODE_GEN_UI_OUTPUT_ROOT` **同进程同源**（`sanitizeZCodeRuntimeEnv` 同一处计算）。
- Agent 上下文注入目录由 `resolveGenUiOutputDirectory` 产出（`apps/zcode-cli/packages/core/src/runtime/helpers/gen-ui-output.ts`）；远端经 `applyPresentationSurfaceToCommand`（`--surface desktop`）→ `normalizePresentationSurface` 归一为 `zcode_desktop`，故**远端会话确实会注入 WSL POSIX 目录**。
- 渲染侧 `useGenUi`（`packages/ui/src/hooks/useGenUi.ts`）的 `files` 服务取自 `useWorkspaceServicesResolution`：有 remote session 走 `remoteServiceAccess.genUiService`（远端），否则落 **base services（本机 Windows）**。
- 两边 visualizations 的会话 hash 目录**交集为 0**（scope 含 workspacePath/identity 形态，两端本就不同；hash 只影响写端目录组织，读端校验不看 hash）。
- 桌面 host 会**在 Windows 根下按会话创建目录**（本机根下的会话目录已实测存在且为空），即桌面侧以「Windows 根 + 该会话目录」为期望写入位置——与 Agent 在 WSL 写入的位置结构性错配。

### 问题二：渲染失败对模型零感知（已确认，代码无任何回传通道）

渲染发生在消息完成后：`projectGenUiReferences` 解析回复文本 → `GenUiCard` → `readDocument` 失败 → 卡片显示
`genUi.failed` + 原始错误文本 + 重试按钮（`packages/ui/src/gen-ui/components/GenUiCard.tsx:94-100,167-178`）。
失败**不进工具结果、不进下一轮上下文、无事件投递、也无任何日志**（gen-ui 全链路无 logger 调用）。
模型写完即认为成功；用户点重试也只在 UI 层重读，模型全程无感知，下一轮照旧引用错误路径。
实证：`sess_6c7e0bce` 事故里报错是靠**用户手工粘贴**才到达模型的（该会话 text part 原文可见），模型此后自行排查才发现双根。

### 已确证结论：假设 A 成立（2026-10-16 取证，证据链见文末）

用户实际报错的会话 `sess_6c7e0bce-7b1d-4741-a695-49817c1b0141`（「Selection side chat」划选辅助对话，WSL 执行，工作目录 `luosheng-frontend/apps/creator`）
给出完整裁决：**写端在 WSL 且路径正确，读端落在桌面 Windows**——

- Agent 写入 `/home/rayn/.zcode-rayn/v2/visualizations/468bcf39.../field-width-tiers.html`，其上下文注入根同为 `ZCODE_GEN_UI_OUTPUT_ROOT=/home/rayn/.zcode-rayn/v2/visualizations`（模型自证 "my file IS inside the root"）；
- 报错 `Gen UI file is outside the host output directory` 是**用户在桌面看到后手工粘贴给模型**的（该会话 text part 原文：「…在我这里看是无法加载交互视图 / Gen UI file is outside the host output directory」），模型并非自动感知——这是问题二的直接证据；
- 模型自行排查后记录：「TWO visualization roots：WSL 侧 `/home/rayn/.zcode-rayn/v2/visualizations/`（298 目录）、Windows 侧 `/mnt/c/Users/rayn/.zcode-rayn/v2/visualizations/`（少量目录，**全空**）」。

Windows 侧目录全空说明：桌面 host 会按会话在 Windows 根下创建目录（本会话对应目录即系统提示里声明的 `aa773021...`），但 Agent 在 WSL 执行、从未写到那里；读端以 Windows 根校验 POSIX 路径，`isAbsolute` 判 true 后 `relative` 越界——与上文映射表第一行完全吻合。

由此**假设 B 排除**（模型引用的是注入的 POSIX 目录，不是 UNC/项目路径），修法收敛为「修读端路由」一条，无需路径形态兜底。

### 读端为何落本机（2026-10-17 已定位到判据）

`useGenUi` 的服务解析本身是对的（远端会话解析到 `remoteServiceAccess`），断点在**服务集合装配漏项**，共两处：

1. 桌面 Host 的 `createRemoteWorkspaceServiceCollection` 没有注册 `IGenUiService`，远端连接暴露的服务集合里没有 `gen-ui` 通道；
2. renderer 的 `buildRemoteWorkspaceSessionServices` 用 `...baseServices` 合并远端服务时，没有把 `genUiService` 覆盖成远端实例。

结果：`sessionsById[remoteSessionId].services.genUiService` 就是本机 base 实例，`readDocument` 永远在 Windows 根上校验 POSIX 路径。取证方式：在 renderer 里比较 `resolution.services.genUiService === baseServices.genUiService`（实测为 `true`），并观察 `gen-ui.readDocument` 的失败栈落在桌面 Host 进程。

修法：Host 侧注册一个组合服务——`readDocument` 走远端 `connectionServices.genUiService`（与 Agent 写入根同进程同源），widget state 与 sandbox 仍委托本机 base（sandbox 注册表只在桌面主进程存在）；远端未暴露 `gen-ui` 时 fail closed，**不回落到本机读**。renderer 合并时把 `genUiService` 显式指向远端实例。

### 反馈闭环的两个缺口（2026-10-18 修复）

路由修好后还剩下的问题：**失败事实送出去了，但送出去的信息不足以让模型改对**。实测形态是模型生成了完整 HTML 文档
（`::visualize` 只接受片段），连续两次渲染失败、模型两次都选择了「重写一份完整文档」，因为它收到的通知里没有任何关于
「片段 vs 文档」的信息：

1. `classifyGenUiRenderFailure` 没有片段这一类，`Gen UI requires an HTML fragment` 落到 `other`，注入文本里显示「失败原因：未知原因」；
2. 报告只带 `errorKind`，读端错误原文没有回传，模型看不到「它是完整文档」这句唯一有信息量的话；
3. 去重键 = `sessionId + path + errorKind`，模型把同一个文件改写后仍同类失败时会被当成重复而**不再提醒**，闭环断在这里。

修法（本 spec 决策 2/3 的落地）：新增 `invalid_fragment` 归类（读端与渲染侧共用 `GEN_UI_FRAGMENT_REQUIRED_MESSAGE`，
不再靠各自的字面量匹配）、报告携带有界 `detail`、去重键加 `detail`；读端的形态违规消息里加**内容指纹**
（字节数 + `sha256` 前 16 位，不含文件内容），使「内容变了」与「重复失败」在键上可区分。

### 反馈闭环的第三个缺口：报告打到了错误的运行时（2026-10-18 修复）

`GenUiCard` 用 `useOptionalBaseWorkspaceServices().zcodeAgentService` 上报，那是**本机 base**。
远端（WSL/SSH）会话的运行时在执行端，本机 CLI 的会话库里根本没有这个 sessionId，`reportGenUiRenderFailure`
直接 `session_not_found` 返回——**不抛错、不打日志**，UI 侧 `catch` 也接不到，报告静默消失。

取证（2026-10-18 01:2x）：本机 Windows 会话库（`C:\Users\rayn\.zcode-rayn\cli\db`）有 **37 条** `可视化渲染失败` 注入，
WSL 会话库同一时间窗 **0 条**，而同期日志里有 4 次远端 `gen-ui.readDocument FAIL ... requires an HTML fragment`
（栈指向 `/home/rayn/.zcode/server-rayn/zcode-server.cjs`）。即：本机会话闭环有效，远端会话闭环从未生效。

修法：上报通道与读端同源——`useGenUi` 从**会话解析结果**（`resolveWorkspaceServicesForTarget`）里取
`zcodeAgentService`，并把解析后的 `workspaceIdentity` / `remoteSessionId`（含 fork/侧聊的镜像身份回退）一并交给报告；
本机会话解析结果就是本机 services（行为不变），远端会话解析到远端。回归用例
`ui/test/genUiCardFailureReport.test.ts`（旧实现下没有 base services 提供者，断言必然失败）。

## 设计决策

1. **同源路由是硬不变式：渲染读取的 `outputRoot` 必须与 Agent 写入的 `outputRoot` 同进程同源，不引入跨文件系统路径翻译。**
   跨机翻译（UNC ↔ POSIX ↔ `/mnt/*`）需要 distro 名、盘符挂载等平台元数据，是分支复杂性的开端，且翻译错了会把越界校验变成筛子。
   根因在路由与反馈两端修：远端会话 `files` 必须解析到执行端服务（已确证读端落本机，修 `useWorkspaceServices` 判据，见上文）；引用形态错误靠失败回传让模型自纠（假设 B 已排除，此闸保留为通用保险）。
   Windows 读端永远不接受 POSIX 路径（`isAbsolute` 语义差异是 Node 平台事实，不试图在 `files.ts` 里打补丁绕过）。

2. **失败回传走「CLI 侧 pending 单源 + 下一轮注入、注入即清」，与 goal deadline 预警同族。**
   - 报告入口：新增协议操作 `session/gen-ui-report`（schema 落 `packages/shared/src/zcode-protocol/index.ts`），携带 `{ sessionId, workspaceRef, path, errorKind, readerRoot, detail }`；
   - `errorKind` 为枚举（`outside_root` | `invalid_path` | `invalid_fragment` | `not_found` | `sandbox_mismatch` | `other`），不透传原始英文错误串（跨端契约稳定、避免 UI 文案当协议）；
   - `detail` 是**有界**的读端错误原文（折成一行、上限 `GEN_UI_RENDER_FAILURE_DETAIL_MAX_LENGTH` = 400 字符）：模型据此看到读端究竟拒了什么，不再受 `errorKind` 粗粒度归类的信息损失影响；
   - CLI 侧（bootstrap `server-operations` 接入 → core 会话状态）持有 pending，**单源在 contracts 层的会话状态**（与 goal warning flag 同一模式，不落两处）；
   - **投递语义沿用 `enqueueBackgroundTaskNotification`**：轮内 steer，空闲会话由空闲唤醒批次投递（不是本项目另造的开轮逻辑）。
   - 注入即清 + 同键去重（键 = `sessionId + path + errorKind + detail`）+ 每会话累计注入上限 5 条，三道闸防环。
     键含 `detail` 是**刻意**的：读端形态违规的消息里带内容指纹（见「失败语义」），因此「模型改写文件后仍同类失败」能再提醒一次，而同一份内容的重复失败维持去重。

3. **注入文案默认只陈述事实，不含纠正指令；唯一例外是形态契约违规（`invalid_fragment`）。**
   内容 = 失败的引用路径、errorKind 对应原因、读端实际输出根、读端诊断（detail）；是否重新生成、改用哪个路径由模型自行判断——避免盲从注入文本反复重试（与辅助对话身份修复同一教训）。
   例外依据：`invalid_fragment` 的修法唯一（保留 `<style>`/`<body>` 内容、删除 `<!doctype>`/`<html>`/`<head>`/`<body>` 外壳、原地改写同一路径），不存在「盲从导致多解乱试」的风险；而缺这条指令时模型的实际反应是**重画整个视图**（2026-10-18 实证），代价高于给一条确定指令。

4. **UI 面保持现状，不加「已通知模型」标记。** 失败态（图标 + 错误文本 + 重试按钮）已足够，模型下轮自纠后卡片自然恢复；额外标记徒增状态同步。渲染失败补 `logger.warn`（读端 root、引用 path、errorKind——定位证据链依赖它）。

5. **上下文注入段落强化路径形态要求**（`apps/zcode-cli/packages/core/src/context/sections/desktop.ts` 的 inline Gen UI 段）：明确「`::visualize` 的 `path` 必须逐字使用下方注入目录拼接文件名，不得使用其它形态路径（含 UNC、项目目录）」。
   同段另有一条**形态契约**：「文件必须是 HTML 片段，不得包含 `<!doctype>`/`<html>`/`<head>`/`<body>`，宿主会拒绝；片段内的 `<style>`/`<script>` 允许」。
   两条都属于「把读端硬性校验提前告诉模型」，与失败回传互为兜底：规则写清楚是主路，回传是规则被忽略时的补救。

6. **明确不做**：跨机路径翻译（决策 1）、渲染失败自动重生成、存量可视化文件迁移（见迁移边界）、把完整文档**自动拆壳**成片段。
   自动拆壳的理由：外壳里的 `<head>` 可能带 `<script>`、`<base>`、外链 CSS，正文可能用 `html/body` 选择器与相对 URL，静默重写会把「渲染失败」换成「渲染成功但样式/交互坏了」——比报错更糟。主路是让模型按契约自己改（规则 + 回传），而不是宿主猜。

## 行为

渲染失败回传链路的事件顺序与所有者（`|` 竖线 = 进程边界）：

```
[执行端 Host 进程]                  [UI 进程 (renderer)]                  [CLI 进程 (bootstrap/core)]
 Agent 写入 <outputRoot>/<hash>/x.html      |                                      |
       |                                   |  readDocument(path)                   |
       |                                   +--(远端会话经 remoteServiceAccess)---->+ readGenUiDocument
       |                                   |        relative(outputRoot, path) 越界 → throw
       |                                   |<-- errorKind + logger.warn ------------+
       |                                   |  session/gen-ui-report                 |
       |                                   +----------------------------------------> 写 pending
       |                                   |     （单源、覆盖式、同键会话内去重）      |（contracts 会话状态）
       |                                   |                                      |
       |                        下一次轮次组装（用户输入 / 既有自动续跑，不主动开轮）    v
       |                                   |              检查 pending → 注入事实段 → 清 pending
       |                                   |              记 injectedKeys / injectCount（防环三闸）
       |        模型在该轮上下文看到失败事实 <---------------------------------------+
```

| 环节           | 位置                                                                        | 行为                                                                                                                                 |
| -------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 渲染失败捕获   | `ui/src/gen-ui/adapters/page.ts` `preparation` catch → `GenUiCard` 失败态   | 现状不变：卡片显示失败 + 原始错误文本 + 重试按钮                                                                                     |
| 失败日志       | `GenUiCard` 报告分支                                                        | `logger.warn("gen-ui render failed", { errorKind, path, sessionId, workspacePath })`；不上报文件内容                                 |
| 报告调用       | `GenUiCard` 失败分支（本组件内同键去重后）                                  | 会话具备运行时且该键未报告过 → 调 `zcodeAgentService.genUiReportRenderFailure`；接口失败仅记 `logger.warn`，**不影响渲染 UI**        |
| 协议 schema    | `shared/src/zcode-protocol/index.ts`                                        | `zcodeSessionGenUiReportParamsSchema`（严格：sessionId、path、errorKind 枚举、readerRoot 可选、workspaceKey 可选、detail 可选 ≤400） |
| 操作接入       | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts` | 校验后按防环三闸把失败事实作为 model-only task-notification 注入（`enqueueBackgroundTaskNotification`）                              |
| 失败账本       | 同上（`record.genUiRenderFailureLedger`，进程内存）                         | `injectedKeys` = 同键终身一次；`injectCount` = 每会话上限 5 条；重启丢失可接受                                                       |
| 注入即清       | `enqueueBackgroundTaskNotification` 的一次性投递语义                        | 通知投递后自动消费，不需要「注入时清 pending」的第二次状态写                                                                         |
| 注入文案       | `formatGenUiRenderFailureNotification`                                      | 固定模板：引用路径 + errorKind 原因 + 读端输出根 + 读端诊断（detail）+ 片段契约修正指令（仅 `invalid_fragment`）+ path 形态参考      |
| 上下文强化     | `core/src/context/sections/desktop.ts`                                      | inline Gen UI 段补「path 必须逐字用注入目录」与「文件必须是 HTML 片段」两条约束                                                      |
| 路由不变式验证 | `ui/src/hooks/useWorkspaceServices.tsx` 消费方                              | 远端会话（`workspaceIdentity`/`remoteSessionId` 非空）的 `genUiService` 必须解析到 remote services；发现落 base services 即为缺陷    |

## 所有权与不变式

- **`outputRoot` 的唯一所有者是执行端 Host 进程**：写端目录（spawn 注入 env）与读端校验根必须由同一进程计算；任何一端改根必须同进程同步，禁止 UI/渲染端自行推导另一端根。
- **读端同源不变式**：远端会话的 `readDocument` 只能路由到执行端 `IGenUiService`；不允许「远端不可达时降级读本机根」——降级读本机根就是本 bug 的形态，不可达应显式 offline（现状 `rpcReady=false` 走 offline 展示，保持）。
- **pending 单源**：渲染失败事实只在 CLI 侧会话记录（`genUiRenderFailureLedger`）存一份；`packages/services` / `packages/ui` 不持有副本（UI 侧只做本组件内同键报告去重，属会话内去噪，不是事实源）。
- **注入一次性**：通知由 `enqueueBackgroundTaskNotification` 一次性投递；同键（`sessionId+path+errorKind+detail`）生命周期内至多注入一次；每会话至多 5 次。三者独立生效。
- **detail 有界且无内容**：`detail` 是读端错误消息折行截断后的文本，只可能包含路径、字节数与内容摘要，绝不含文件内容；上限由 `GEN_UI_RENDER_FAILURE_DETAIL_MAX_LENGTH` 两侧共同约束。
- **校验规则不变**：`files.ts` 的 `isAbsolute` + `relative` 越界校验与片段形态校验都是安全边界，本 spec 不放宽任何一条判定（片段违规只是**多了归类与回传**，不是放宽拒绝）。

## 失败语义

- `session/gen-ui-report` 调用失败（会话离线、协议错、超时）：渲染 UI 不受影响，仅 `logger.warn`；报告丢失可接受（反馈是尽力而为，不是业务事实）。
- 报告时会话已不存在：静默丢弃（渲染失败发生在 UI 打开会话期间，属罕见竞态）。
- 去重与内容指纹：形态违规（`invalid_fragment`）的读端消息里带内容摘要，`detail` 随之变化 →
  「模型改写文件后仍不合规」会再注入一次；同一份内容重复失败（含用户点重试）仍被去重。
  其余 kind 的 `detail`（如 ENOENT 原文）通常稳定，行为与本轮之前一致。
- pending 积压（会话长期不开轮）：通知按 task-notification 语义投递，不会因会话空闲而丢失或堆积。
- 防环终局：同键注入过 → 不再注入；会话注入满 5 次 → 不再注入。此后失败仅剩 UI 卡片与日志可见，不产生任何自动行为。
  改文件可以让键复活，但 5 次上限始终封顶（模型反复改仍不合规时最多再提醒 4 次）。

## 迁移边界

- **存量可视化文件不迁移、不清理**：两端散落的历史文件（Windows 60+ / WSL 303 个 hash 目录）保持原状；它们只被各自历史会话引用，同源路由修复后新渲染不再依赖跨端读取。
- **历史失败不回溯**：已发生且未回传的渲染失败不补注入（当时的上下文已不可重建）。
- **协议向后兼容**：`session/gen-ui-report` 为新增操作，旧端收到未知操作按既有未知操作语义拒绝；不做能力协商（报告调用方有 try/catch 降级）。
  `detail` 为可选字段：旧端上报不带它，去重键退化成 `sessionId+path+errorKind+空串`，与本轮之前的去重行为一致；旧读端（未带指纹的消息）行为也一致（`invalid_fragment` 归类仍生效，因为匹配的是既有文案）。
- **形态违规的读端文案是指纹载体，改动需同轮**：`GEN_UI_FRAGMENT_REQUIRED_MESSAGE` 与指纹后缀由 `@zcode/shared/gen-ui` + `files.ts` 定义，`classifyGenUiRenderFailure` 用同一常量匹配；
  改文案时必须同时确认渲染侧归类仍命中（`ui/test/genUiRenderFailure.test.ts` 与 `services/src/gen-ui/adapters/files.test.ts` 两条断言锁死）。
- **需重建才生效**：读端错误文案由执行端（远端 server bundle）产出，`detail`/指纹要生效需重建并重启该 bundle；桌面本地读取只需重建桌面。
- **UI 状态与 i18n 无改动**：`genUi.failed` 等既有文案沿用，不新增 locale key（errorKind 只进日志与注入模板，模板文本在 CLI 侧注入 section 内，不走 UI i18n）。

## 证据链与复现方法

### 已确证证据（2026-10-16）

会话 `sess_6c7e0bce-7b1d-4741-a695-49817c1b0141`，来源 = 执行端（WSL）会话库 `/home/rayn/.zcode-rayn/cli/db/db.sqlite`：

```bash
# 1) 报错文本落在哪些 part（`outside the host output` 是全库唯一可定位串）
sqlite3 -readonly "file:<db>?mode=ro" \
  "SELECT session_id, json_extract(data,'$.type'), substr(data,1,300) FROM part WHERE data LIKE '%outside the host output%' LIMIT 10;"
# 2) 模型对「两个根」的完整推理（模型自己发现了 Windows/WSL 双根、Windows 侧目录全空）
sqlite3 -readonly "file:<db>?mode=ro" \
  "SELECT json_extract(data,'$.text') FROM part WHERE session_id='sess_6c7e0bce-...' AND data LIKE '%TWO visualization roots%';"
```

配套事实：`ZCODE_GEN_UI_OUTPUT_ROOT` 在该会话 = `/home/rayn/.zcode-rayn/v2/visualizations`（写端根，模型自证文件在其下）；
Windows 根 `C:\Users\rayn\.zcode-rayn\v2\visualizations` 下会话目录全空（桌面 host 建目录、无文件）。

### 快速复核判据（可复现）

复现一次远端（WSL）会话的 Gen UI 生成，抓三样证据对照下表：

1. **引用形态**：会话数据里 `::visualize` 的 `path` 原文——POSIX `/home/rayn/...` 还是 UNC/项目路径；
2. **读端归属**：`useGenUi` 的 `resolution.services` 是否 `rpcReady` 且来自 `remoteServiceAccess`；或看 `readGenUiDocument` 实际执行进程与 `outputRoot`（Windows 根 / WSL 根）；
3. **卡片错误文本**：`outside the host output directory` / `Invalid executor path` / `sandbox mismatch`。

| 引用形态           | 读端    | 预期错误                            | 结论                                 |
| ------------------ | ------- | ----------------------------------- | ------------------------------------ |
| POSIX 注入目录     | Windows | `outside the host output directory` | **假设 A（已确证）：修读端路由判据** |
| POSIX 注入目录     | WSL     | 无错误（能渲染）                    | 同源路由正常，需回现场取新证据       |
| UNC / Windows 形态 | WSL     | `Invalid executor path`             | 引用形态错：靠失败回传自愈（决策 2） |
| 项目目录路径       | 任一    | `outside the host output directory` | 注入段强化（决策 5）+ 失败回传       |

### 读端路由的修法范围

`packages/ui/src/hooks/useWorkspaceServices.tsx` 的 `resolveWorkspaceServicesForTarget`（`isRemoteTarget` / `resolvedRemoteSessionId` 一系）在「远端执行端 + fork/侧聊会话」上的取值，补齐判据并加契约测试——**只修判据，不改读取校验**（`files.ts` 三道防线原样保留）。

## 验收

- A1 桌面本地会话：可视化生成与渲染回归不变（本机根同根通路）。
- A2 远端（WSL）工作区会话 + POSIX 注入目录引用：渲染成功（读端 = 执行端服务，同根）——本 spec 的核心回归。
- A3 远端会话 + 错误形态引用：卡片失败（现状文案），且下一轮上下文含注入的事实文本（引用路径、读端根、期望目录、errorKind）。
- A4 同键失败重复渲染（含点重试）：`session/gen-ui-report` 只报告一次、下一轮最多注入一次；会话累计 5 次后不再注入。
- A5 渲染失败时空闲会话不被唤醒（无新轮次产生）；注入只出现在用户下次输入或既有自动续跑的轮次里。
- A6 `session/gen-ui-report` 端点不可用（会话离线/协议错）：渲染 UI 行为与现状一致，仅日志 warn。
- A7 路由契约测试：带 `workspaceIdentity`/`remoteSessionId` 的远端会话断言 `files` 解析到 remote services；本地会话断言解析到 base services。
- A8 失败日志：任一渲染失败产生一条 `logger.warn`，含 errorKind 与引用 path（供定位步骤复用）。
- A9 **fork/侧聊会话 + 远端执行端**：断言 `files` 解析到执行端 remote services（本次事故形态，`sess_6c7e0bce` 即划选辅助对话）。
- A10 完整文档被引用时：归类为 `invalid_fragment`（不是 `other`），注入文本含读端诊断与片段契约修正指令
  （`ui/test/genUiRenderFailure.test.ts`、`apps/zcode-cli/packages/bootstrap/tests/gen-ui-render-failure-report.test.ts`）。
- A11 内容指纹可区分「重复失败」与「改写后仍失败」：读端同一份内容给出同一消息（`files.test.ts`），
  CLI 侧同一 `detail` 去重、`detail` 变（模型改写）后允许再注入一次，总量仍受 5 次封顶（报告测试）。
- A12 远端会话的渲染失败报告打到执行端 zcode-agent，且带 `remoteSessionId`/镜像 `workspaceIdentity`；
  本机 CLI 不再收到该会话的报告（`ui/test/genUiCardFailureReport.test.ts`）。
