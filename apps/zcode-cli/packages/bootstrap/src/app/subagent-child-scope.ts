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
