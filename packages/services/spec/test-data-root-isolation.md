# services 单测的数据根隔离

涉及包：`packages/services`（仅测试与测试助手；不改生产解析顺序）。

## 背景与问题

`packages/services` 的单测需要写入「应用数据根」（provider 个人配置、task 快照、Project Memory 目录等），因此必须把数据根钉在临时目录里。

原先测试用 `setDataBaseDir(临时目录)` 封根。但数据根的解析顺序是：

```
setDataRootDir()  >  ZCODE_DATA_ROOT(env)  >  {dataBaseDir}/.zcode
```

ZCode 会话自身就是宿主进程的子进程，环境里天然带着 `ZCODE_DATA_ROOT`（自建版为 `~/.zcode-rayn`）。`setDataBaseDir()` 的优先级低于 env，于是**封根完全失效**，测试会直接读写真实用户数据根。2026-10-03 实测到的后果：

- `nonCliAcpRetirement.test.ts`：Project Memory 目录解析到真实 root，断言 1 个项目实得 8 个。
- `providerConfigMigration.test.ts`：`getAppConfigDir()` 落到真实 `v2/`，而上一次运行已在那里留下 `personal.json`，`start()` 因此判定「个人配置已存在」跳过旧配置迁移——`readCount()` 恒为 0，`recoveries` 恒空，跑一次之后永久红。
- `importedClaudeRecovery.test.ts`：task 快照写进真实 `v2/sessions/<hash>/`。

即在带 `ZCODE_DATA_ROOT` 的 shell（也就是「在 ZCode 里跑测试」这个默认场景）下，39 个用例里有 3 个恒假红，同时在用户真实数据根留下垃圾文件。

## 设计决策

1. **测试改用上层封根入口 `setDataRootDir()`，不再单独使用 `setDataBaseDir()`。** `setDataRootDir()` 的优先级高于 env，是 2026-09-27 身份隔离时新增的、专供「按产品身份定向数据根」的入口；测试正是它的适用场景。
2. **封根时按生产规则推导数据根**：`setDataRootDir(getDataRootDirForBaseDir(临时 home))`，复用带身份后缀的唯一推导函数，不在测试里手写 `join(base, ".zcode")`。同时仍调用 `setDataBaseDir(临时 home)`，让不经过数据根的 `getDataBaseDir()` 调用点也隔离。
3. **清理交给 `node:test` 的 `t.after()`**，由助手在创建资源处注册恢复与删除；测试正文不再写 `try/finally`，避免「忘记恢复」这一类泄漏。
4. **封根后立即断言解析结果等于预期数据根**，不等则立刻抛错并带上实际解析值。宁可测试红，也不能静默写真实数据。
5. **不改生产解析顺序。** `ZCODE_DATA_ROOT > {dataBaseDir}/.zcode` 是宿主向子进程下发身份数据根的既定语义（`dataRootIsolation.test.ts` 已固化该不变量），测试应当使用正确的封根入口，而不是反过来弱化 env 的优先级。

## 行为

- 助手 `sealDataRoot(t, prefix)`（`packages/services/test/helpers/sealedDataRoot.ts`）：
  - 建临时 home，`setDataBaseDir(home)` + `setDataRootDir(getDataRootDirForBaseDir(home))`；
  - 断言 `getZCodeDataRootDir()` 等于该数据根；
  - 通过 `t.after()` 依次恢复两个 setter（置 `null`，回到 env/homedir 语义）并递归删除临时目录；
  - 返回 `{ baseDir, dataRoot, configDir }`，其中 `configDir = {dataRoot}/v2`，与生产一致。
- 用法：`test("...", async (t) => { const root = await sealDataRoot(t, "zcode-xxx-"); ... })`。
- mailbox 相关测试不在本机制内：它们把 `rootDir` 显式传给 `createNodeSessionMessageMailbox({ rootDir })`，本身已隔离。

## 不变式

- services 测试进程内，数据根必须位于本次测试创建的临时目录之下；任何解析到临时目录之外的调用都是缺陷。
- 数据根一旦被封，只能由创建它的助手在 `t.after()` 中恢复；测试正文不得自行改写数据根。
- 生产解析顺序不因测试需要而调整。

## 失败语义

- 封根断言失败（解析结果逃出临时目录）→ 立即抛错，测试红。信息包含实际解析到的路径，便于直接定位是哪个封根入口被绕过。
- 宿主环境有无 `ZCODE_DATA_ROOT` 不影响结果：封根优先于 env，两种环境下用例行为一致。

## 迁移边界

- 影响范围：`packages/services/test/` 下 3 个会写数据根的用例文件，以及新增的助手与回归测试。
- 其他包（如 `apps/zcode-cli`)若有同类「只调 `setDataBaseDir()` 封根」的测试，属同一根因，另行治理。
- 2026-10-03 清理的真实数据根残留（移入隔离目录 `%TEMP%/zcode-test-litter-20261003/`，可回溯）：
  - `v2/config.json`、`v2/personal.json`（providerConfigMigration 夹具）
  - `v2/sessions/5f3fed368cd6/wrapper-example.json`、`v2/sessions/c7ba2ab27bca/claude-import-example.json`（task 快照夹具）
  - `cli/memories/projects/example-0123456789abcdef/`（Project Memory 夹具）
