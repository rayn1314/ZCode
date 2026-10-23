/**
 * usage-ledger 对外契约：调用方要想正确调用就必须知道的一切都写在这里；其余对外不可见。
 *
 * 模块意图：把一台机器上同时存在的多个数据根（Windows 官方根 / 自建 `.zcode-<身份>` 根 /
 * WSL 各发行版内的根）聚合成一份只读用量账本，并把手动定价与模型别名做成可写能力。
 *
 * 唯一状态所有者：host 进程内的 `LedgerReader`（只读短连接聚合）。UI 没有本地聚合状态，
 * 只有筛选偏好（localStorage `zcode.ledger.prefs.v1`）。
 *
 * 全局不变量（完整口径见 packages/services/spec/usage-ledger.md）：
 * 1. 只读：SQLite 全程 `readOnly: true` + 短连接，用完即关；WSL 侧绝不从 Windows 直开对方的库，
 *    一律把聚合脚本送进 WSL 执行、只回传 JSON。
 * 2. 口径：`cacheRead ⊂ input`、`reasoning ⊂ output`，任何 token 合计只用 `input + output`；
 *    费用先把命中部分从输入里扣掉再计价（`(input − cacheRead)·pIn + output·pOut + cacheRead·pCache`），
 *    否则命中 token 按未命中价与缓存价各算一遍（双计费）。
 * 3. 未定价模型的调用显式记入 `unpricedCalls/unpricedModelIds`，绝不静默按 0 算。
 * 4. 多源合并：计数求和、均值（耗时/TTFT）按调用数加权、`recent` 与顶层会话按配额截断；
 *    会话截断必须保父链完整（父在集合里而子被保留、或子被保留而父被丢掉都不允许）。
 * 5. 价格写操作只动用户覆盖层 `<数据根>/v2/usage-prices.json`；同步层与内置基准不受影响。
 * 6. 服务只在桌面本地 host 注册（`packages/services/src/node.ts`）：远端 workspace / Web 上
 *    `accessor.usageLedgerService` 为 undefined，UI 走「当前环境不支持」空态而不是报错。
 */
import type {
  LedgerPriceAliasSetRequest,
  LedgerPriceDeleteRequest,
  LedgerPriceEntry,
  LedgerPriceListRequest,
  LedgerPriceListResult,
  LedgerPriceMutationResult,
  LedgerPriceSetRequest,
  LedgerPriceSyncResult,
  LedgerRange,
  LedgerSessionRow,
  LedgerSnapshot,
  LedgerSnapshotRequest,
  LedgerSource,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type { IUsageLedgerService as IUsageLedgerServiceImplementation } from "./usageLedger.js";

export type {
  LedgerPriceAliasSetRequest,
  LedgerPriceDeleteRequest,
  LedgerPriceEntry,
  LedgerPriceListRequest,
  LedgerPriceListResult,
  LedgerPriceMutationResult,
  LedgerPriceSetRequest,
  LedgerPriceSyncResult,
  LedgerRange,
  LedgerSessionRow,
  LedgerSnapshot,
  LedgerSnapshotRequest,
  LedgerSource,
};

export interface IUsageLedgerService {
  /**
   * 读一次聚合快照（只读，无副作用，不写任何库）。
   *
   * 前置：`request.range` 为 `custom` 时 `customStart/customEnd` 必须是 `YYYY-MM-DD`；
   * `sourceKeys` 缺省/null 表示全部可用来源。
   * 后置：`snapshot.sessions` 每行数值 = 该会话自身 + 全部后代（fork 断边）；
   * `overview.peakDay*` 只在多源合并层推导，单源可能缺省。
   * 失败语义：主源（host 自己的数据根）读取失败且被选中时 reject；其余来源失败只体现在
   * `snapshot.sources[].ok=false`，不挡页面。不等待任何持久化。
   */
  getLedgerSnapshot(request: LedgerSnapshotRequest): Promise<LedgerSnapshot>;

  /**
   * 手动同步价格基准：拉 models.dev 公开目录写入同步层 `<数据根>/v2/usage-prices-baseline.json`。
   *
   * 幂等：同一份目录重复同步结果一致（只在成功时覆盖同步层）；用户覆盖文件绝不被动。
   * 失败：`ok=false` + `error`，旧基准原样保留。成功后使价格缓存失效，下一次快照即用新价。
   */
  syncLedgerPrices(): Promise<LedgerPriceSyncResult>;

  /**
   * 合并后的价格表（内置 < 同步 < 用户覆盖，别名已展开），按模型 id 子串过滤后分页。
   *
   * 只读。`entries` 被 `limit`（缺省 200，上限 500）截断，`total` 始终是过滤后的总数；
   * `entries[].source` 是该键的最终来源层，别名展开出来的键记 `user` 并带 `aliasOf`。
   */
  listLedgerPrices(request: LedgerPriceListRequest): Promise<LedgerPriceListResult>;

  /**
   * 写用户覆盖价（三价必须非负有限数，模型名按小写键写入）。
   *
   * 幂等：同值重复写入结果一致。副作用：若同一模型名当前是别名，会一并删除该别名，让显式定价生效。
   * 读-改-写整个用户覆盖文件，保留其它未知键与 `_meta`；用户覆盖文件损坏时拒绝写入并回传错误
   * （不覆盖原文件，避免把用户手写的整份价格表抹掉）。返回时写入已落盘。
   */
  setLedgerPrice(request: LedgerPriceSetRequest): Promise<LedgerPriceMutationResult>;

  /**
   * 删除用户覆盖价 = 恢复默认（回落到同步层或内置基准）。
   *
   * 幂等：键不存在时同样返回 `ok=true`（状态已是目标状态）。只改用户覆盖文件，其余层不动。
   */
  deleteLedgerPrice(request: LedgerPriceDeleteRequest): Promise<LedgerPriceMutationResult>;

  /**
   * 设置或删除模型别名（`target` 为 null/空串即删除）。
   *
   * 幂等：同一映射重复设置结果一致。别名只在加载时沿映射链展开（深度上限 8，成环即中断，
   * 别名保持未定价且不抛错），显式定价优先于别名。副作用：设置别名时若同名键有用户显式定价，
   * 一并删除该定价，让别名真正生效。
   * 失败：别名等于目标（自指）返回 `ok=false` + 错误文案，不改动文件。
   */
  setLedgerPriceAlias(request: LedgerPriceAliasSetRequest): Promise<LedgerPriceMutationResult>;
}

export const IUsageLedgerService = createServiceDescriptor<IUsageLedgerService>(
  ServiceChannels.UsageLedger,
);

/**
 * 编译期断言：契约与实现互相覆盖，任一侧增删方法或改签名都会在这里报类型错。
 * 契约是调用方唯一需要读的那份说明，实现在 `./usageLedger.js`。
 */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

export type UsageLedgerContractMatchesImplementation = Assert<
  MutuallyAssignable<IUsageLedgerService, IUsageLedgerServiceImplementation>
>;
