import type {
  ExecutionPort,
  FileSystemPort,
  HttpClientPort,
  ImageProcessorPort,
  PdfDocumentPort,
  ToolArtifactStorePort,
} from "@zcode/contracts";
import type { SubagentChildLaunchBundle } from "@zcode/core";

import type { ZCodeAppStartupInputs } from "./startup-inputs.js";

/**
 * 父 App 借给子会话的装配事实（spec `subagent-session-as-first-class.md` D1 / S1b）。
 *
 * 这些是**进程内适配器实例**，不是会话私有状态：子会话若各自新建一份，就会多出第二份执行
 * 适配器 / artifact store，并且脱离父会话的 `onToolExecResource` 追踪。所以子会话一律借用
 * 父会话已经构造好的这一份。
 *
 * 与 `SubagentChildLaunchBundle` 的分工：那份是 core 算得出来的父语境快照与父 runtime 活端口；
 * 这份只有 App 装配处（`create-app.ts` 的闭包）才拿得到，所以放在这里由父 App 借出。
 */
export interface SubagentChildBorrowedPorts {
  /**
   * 父已解析的启动输入（配置 / 插件 / agent profile / 内置技能包）。
   * 子会话复用同一份，不重复做四项磁盘解析（含同步插件发现），见 `startup-inputs.ts` 文件头。
   */
  startupInputs: ZCodeAppStartupInputs;
  executionPort: ExecutionPort;
  fileSystemPort: FileSystemPort;
  httpClientPort: HttpClientPort;
  imageProcessorPort: ImageProcessorPort;
  pdfDocumentPort: PdfDocumentPort;
  artifactStore: ToolArtifactStorePort;
}

/** 子会话 App 的构造入参：core 的覆盖包（父语境 + 父作用域端口）＋ 父借出的装配事实。 */
export interface SubagentChildAppScope {
  bundle: SubagentChildLaunchBundle;
  borrowed: SubagentChildBorrowedPorts;
}

/**
 * 构造 App 时收件箱端口的取法（spec `subagent-session-as-first-class.md` S3）。
 *
 * 规则有三条，顺序不能换：
 * 1. **注入的端口优先**：进程里只允许一份 mailbox 实例（父 App 借出、由
 *    `workspace-model-runtime.ts` 注入）。自建第二份会各持一套未读目录视图，
 *    `consume` 去重与 drain 游标都会分叉。
 * 2. **子会话在没注入时不自己造**：收件箱是"已准入投递"的落点，子会话的端口来源必须是父那一份。
 * 3. 普通会话缺注入时按 env 建默认端口（既有行为）。
 *
 * 为什么单独成函数：这段曾经写成一个三元
 * `childScope ? undefined : (injected ?? fallback)`，把**注入进来的那份也一起丢了**——
 * 于是 S3 在 `workspace-model-runtime.ts` 里"对子会话照常注入"的改动对派发路径完全无效，
 * 而冷恢复路径因为没有覆盖包反而一直有收件箱，两条构造路径的能力面刚好颠倒。
 * 判据写成函数后，这条"注入优先"的规则可以被直接断言。
 */
export function resolveSessionMailboxPort<T>(input: {
  injected: T | undefined;
  isSubagentChildScope: boolean;
  fallback: () => T;
}): T | undefined {
  if (input.injected) {
    return input.injected;
  }
  return input.isSubagentChildScope ? undefined : input.fallback();
}
