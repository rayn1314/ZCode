// ============================================================
// provider 配额的装配：从「环境」算出同机跨端共享要用的那两样东西
// ============================================================
// 限速器与治理器都是进程单例、且刻意不认识 Provider Registry（只吃 resolver），所以「账本落在哪个
// 文件、桶按什么键分、并发读数放在哪个目录」这段决策既不属于账本（纯文件语义）也不属于限速器
// （纯配额语义），只能由装配层决定。放在这里而不是内联在 create-app.ts 里，是为了让这段决策能被
// 单测钉住——它错的方式很安静：路径算错会让共享静默失效。

import { dirname, join } from "node:path";
import type { Logger } from "@zcode/contracts";
import {
  CONCURRENCY_SHARED_DIR_NAME,
  getProviderConcurrencySharedView,
  type ProviderConcurrencySharedView,
} from "./provider-concurrency-shared.js";
import {
  createFileProviderQuotaStore,
  resolveProviderQuotaSharedFilePath,
  type ProviderQuotaSharedStore,
} from "./provider-quota-shared-store.js";

export interface ProviderQuotaSharingInput {
  /**
   * 决定账本位置的来源。缺席时按 `resolveProviderQuotaSharedFilePath` 的缺省读 `process.env`——
   * app 的 `env` 本来就是可选注入。
   */
  env?: Readonly<Record<string, string | undefined>>;
  logger?: Logger;
}

/**
 * 交给 `getProviderRateLimiter` 与 `getWorkflowConcurrencyGovernor` 的共享部分。
 *
 * 两者都缺席 = 不共享，各进程各限各的（非 Windows / 非 WSL，或用户用环境变量显式关掉）——这正是
 * 单进程场景下的行为，逐字不变。
 */
export interface ProviderQuotaSharing {
  sharedStore?: ProviderQuotaSharedStore;
  concurrencyShared?: ProviderConcurrencySharedView;
}

/**
 * 算出跨进程共享所需的两样东西；位置由环境决定，算不出来就都没有。
 *
 * - **RPM 账本**：一个文件，键就是 providerId（由限速器直接取用，装配层不再参与算键）。一条
 *   provider 配置 = 一份策略 = 一个桶，Windows 桌面与 WSL 远端同名即共享。同一家供应商的多个 Key
 *   （中转站多账号）会合用一个桶、互相限速——「多账号」的正确形态是**多建几条 provider 配置**，
 *   而不是让客户端替你猜哪两把 Key 属于同一份配额。
 * - **并发读数**：一个目录，挂在账本旁边（同一块磁盘、同一个开关）。它记的是「每个进程此刻有几个
 *   在飞」，不是「谁持有哪个槽」——取舍见 provider-concurrency-shared.ts 的文件头。
 */
export function createProviderQuotaSharing(input: ProviderQuotaSharingInput): ProviderQuotaSharing {
  const filePath = resolveProviderQuotaSharedFilePath(input.env);
  // 位置算出来就交给账本，不在这里做可写性探测：探测通过也仍可能在写入时失败，用不了自然降级。
  const sharedStore =
    filePath === undefined
      ? undefined
      : createFileProviderQuotaStore({
          filePath,
          ...(input.logger === undefined ? {} : { logger: input.logger }),
        });
  const concurrencyShared = getProviderConcurrencySharedView({
    ...(filePath === undefined
      ? {}
      : { directory: join(dirname(filePath), CONCURRENCY_SHARED_DIR_NAME) }),
    ...(input.logger === undefined ? {} : { logger: input.logger }),
  });
  return {
    ...(sharedStore === undefined ? {} : { sharedStore }),
    ...(concurrencyShared === undefined ? {} : { concurrencyShared }),
  };
}
