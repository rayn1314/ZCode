# 身份数据迁移

意图：并排安装官方版与自建版后，用户从一侧切到另一侧时只能手工 `robocopy` / `cp -r`——无法选域、
无冲突语义、SQLite 会拷到半截、凭据与信任记录被当成普通文件搬。本模块把它做成产品能力：
按**域**粒度勾选迁移，每域策略固定，来源根自动探测（不写死官方），破坏性写操作默认最少惊讶。

不变量：

- **目标已有数据永不被覆盖**：`sessions` / `providerConfig` 整域跳过，其余逐项跳过；
  `conflictCount` 如实上报，界面据此提示「n 项已存在」。需要覆盖时用户先自行删目标文件。
- **单域独立事务**：`migrateDomain` always resolve，失败折成 `status: "failed"` + `error`，
  不中断其它域；`sessions` 内部失败会回滚本次新建产物。`details` 统一截断到 50 条。
- **来源身份不可见性**：探测结果排除当前身份；入参 `sourceRootPath` 必须在探测集合内，
  服务内部重新探测后做集合成员校验（只做字符串比较挡不住「调用方自己拼一个路径」）。
- **写入通路唯一**：写目标身份数据根内的路径，或经目标已注册服务（`settingService` /
  `credentialService`）。凭据逐 key 解密后 `save` 重新加密，绝不整文件复制（避免解不开或双重加密）。
- **只对本机生效**：迁移搬的是运行该服务进程那台机器上的其它身份数据根；WSL / 远端不纳入，
  因此 UI 固定用本地 Host 的 services 渲染。
- **不可逆**：没有撤销入口；重复执行只补新出现的条目，源身份后续新增不会自动同步。

与其它模块的交集在**两个点**处理，没有共享状态：

- 来源探测复用 `data-roots`（`discoverMigrationSourceRoots`），当前身份数据根由调用方注入；
  账本与迁移消费同一份探测结果，规则只实现一次。
- hooks 域只搬**声明**（`{src}/cli/config.json` 的 `hooks.events`，按事件名 + matcher 合并），
  不搬信任记录：目标身份首次触发时仍走 fail-closed 重新授权（信任库落点见 `data-roots`）。
  写回时保留目标 `cli/config.json` 的其它字段（`plugins` / `skills` 开关等）。
- 渲染端接入点：`packages/client/src/remoteServiceAccess.ts` 需显式代理 `IMigrationService` 通道
  （代理类按服务逐项手写，漏列等于界面拿不到服务）。

规则与验收场景来源：`packages/services/spec/identity-data-migration.md`。
契约测试：`packages/services/src/migration/contract.test.ts`（来源集合校验、域顺序与默认勾选、
目标已有不覆盖、合并后目标其它字段不变、重跑幂等）。
