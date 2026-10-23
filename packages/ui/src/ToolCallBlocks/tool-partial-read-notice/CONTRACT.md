# tool-partial-read-notice

意图：工具卡的「读取范围 + 截断种类」两个弱元数据。以前 Read 卡只显示文件名，同一文件
「整读 + 续读」和「整读 + 未变更桩」长得一模一样；除少数卡片外，系统截断也都不可见。

不变量：

- **纯展示**：只读 `toolCall.input` 与已落库的输出文本，不产生状态、不发服务调用、不改协议、
  不落盘。同入参必得同结果，因此历史会话同样生效（文本早就在库里）。
- **单卡最多一枚徽标**，8 类按固定优先级取第一个命中；解析不到返回 `null`，不猜不兜底。
- **grep/glob 的截断判定必须有 `limit:` 证据**：`offset>0` 未截断时 CLI 也会输出分页信息，
  只匹配 pagination/offset 会产生假阳性。
- **Read 范围以输出为准**：`Showing a partial view of lines X-Y of Z` 是实际返回范围（token 上限
  可能比 `limit` 更短），`input.offset/limit` / `input.pages` 只作兜底；全无 = 整读，不显示。
- 标记字符串的所有者在 `apps/zcode-cli` 各 handler，本模块只读匹配；锚点表在
  `packages/ui/test/truncationNotice.test.ts` 文件头。

交集：

- 四张卡（Read / Search / Execute / Fallback）在各自 renderer 里检出并渲染：范围并入路径行
  （`ToolLayout` 的 secondaryText），徽标挂状态区（`noticeChip`）。卡片只消费返回值，不参与判定。
- 协议级结构化截断透传是遗留项：落地时替换 `detectTruncationNotice` 的内部信号源即可，
  组件与槽位不动。

规格：`packages/ui/spec/tool-call-range-and-truncation.md`。
