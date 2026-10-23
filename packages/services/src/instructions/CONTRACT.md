# instructions

## 意图

让用户看见并编辑 Agent **真正会读**的那份指令文件（`AGENTS.md`）：设置页两张卡（用户级 / 仓库级）
展示生效路径、被遮蔽的候选、字节数、截断与只读状态，并提供内联编辑 + 保存。

产品合同与卡片状态机（信息块、操作行、冲突三选一、状态矩阵、INS01–INS12 验收用例）见
`docs/ui/instruction-files-settings.md`；路径候选、读取上限与作用域语义的单一真相源是
`packages/shared/src/instruction-files.ts`（本模块不复制第二份）。

## 不变量

- **与 Agent 侧同口径**：候选顺序 `AGENTS.md` → `.zcode/AGENTS.md` → `.agents/AGENTS.md`，
  自工作目录向上到含 `.git` 的 projectRoot（没有就一路到文件系统根），每级取第一个存在者即停。
  改这里必须同步 Agent 侧读取器，否则设置页展示的不是模型读的那份。
- **落点 ≠ 生效文件**：`targetPath` 是写入落点（仓库级恒为本目录 `AGENTS.md`），`effectivePath`
  是当前生效文件；命中上级目录或同级被遮蔽时两者不同，`exists === true` 时两者相等。
- **读取只读**：不建目录、不写文件、不缓存内容；`content` 只是落点的前 100KB，`truncated`
  与 Agent 侧的「超出部分读不到」同语义。
- **写是唯一写路径且原子**：建目录 + 临时文件 + rename；`expectedMtimeMs` 是唯一并发令牌，
  锁内、rename 前复验，基线过期返回 `conflict` 且磁盘原样保留——不允许静默覆盖别人的改动。
- **可写性实时探测**：落点存在就看落点、否则看最近的已存在祖先目录；不乐观假设，
  真实写入失败再二次映射为 `not-writable` / `failed`。

## 与其它模块的交集（hook 点）

- **服务注入**：设置页唯一注入点是 `packages/ui/src/settings/instructionFiles.ts` 的
  `resolveInstructionsService`（运行时形状校验，服务缺失按加载失败态渲染，不伪造「未创建」）。
  服务只在 host 侧注册（`packages/services/src/node.ts` 的 `instructions/index.js`）。
- **host 解析**：卡片通过 `useWorkspaceServicesResolution` 取当前工作区所属 host，
  远端 workspace 的读写发生在文件真正所在的机器；`用外部编辑器打开` 仅本地渲染。
- **草稿与冲突**：未保存内容唯一的载体是 `useInstructionFileCard` 的 `draft`；任何读取
  （含保存成功后的 silent reload、冲突裁决的刷新）只更新 `snapshot`，绝不静默覆盖草稿；
  冲突判定归服务端，UI 不自行比较 mtime。
- **模板**：新建骨架由 `instructionFiles.ts` 的 `buildInstructionTemplate` 用 i18n 生成，
  写入时 `expectedMtimeMs` 传 `null`（表示「按新建提交」）。
