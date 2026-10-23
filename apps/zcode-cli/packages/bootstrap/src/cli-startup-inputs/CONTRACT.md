# cli-startup-inputs

## 意图

App 创建期那四项磁盘解析（配置 / agent profile / 插件发现 / 内置技能包）的**一次观测快照**。抽成显式
的一步，是为了让「正常会话每次读盘」与「子会话复用父会话那一份」成为两个可以分别看见的路径：前者是
`createZCodeApp` 的默认路径，后者由构造入口把父快照传进来。设计背景与切片见
`core/spec/subagent-session-as-first-class.md` 的「约束二」与 S1b。

## 不变量

- **无缓存**：每次调用都重新读盘，「相同入参复用」不是本模块的语义。冷恢复重建 App 因此天然拿到新
  catalog；已有 Session 不热加载新 Plugin。
- 快照是**只读派生**，唯一例外是 `configResult`（App 自己的 facade 会原地更新其中的 `ui.locale`）。
- 空清单（无插件 / 无 profile / 无技能根）是合法结果；磁盘布局缺失不该让会话创建失败。
- 复用父快照时不重做插件发现：父子必须看到**同一份**插件面与技能根，否则父子策略会分叉。

## 与其它模块的交集

- 与子会话装配的 hook 点是 `create-app.ts` 的**同一个闭包**：子会话借用的不只是这份快照，还有进程内
  适配器实例（执行端口 / artifact store 等），由 `subagent-child-scope.ts` 一次性借出。
- 插件发现本身属于 CLI 插件装配（`startup-marks.ts` / `plugin-runtime-features.ts`）；本模块只负责
  「什么时候读一次」以及把结果装进快照，不改变发现规则。
- 存储根与 model IO 目录的推导复用 `paths.ts` 的既有函数；本模块不新增路径约定。

运行时回归位于 `tests/cli-startup-inputs/`。
