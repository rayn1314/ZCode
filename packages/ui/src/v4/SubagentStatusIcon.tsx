/**
 * 子代理生命周期状态的图标。左栏子区块与子代理目录面板共用同一套图标，
 * 并复用 `subagentDirectory.status.*` 的文案（七态齐备），不新造第二套状态语汇。
 *
 * `label` 用于「图标是唯一状态指示」的场合（左栏子区块右侧只有一个图标）；
 * 目录面板自己就把状态词写在标题旁，所以那里保持 `aria-hidden`，不要重复朗读。
 */
import {
  BanIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  CircleDashedIcon,
  LoaderCircleIcon,
  PauseCircleIcon,
} from "lucide-react";
import type { SubagentLifecycleStatus } from "@/v4/subagentLifecycleStatus.js";

export function SubagentStatusIcon({
  status,
  className = "size-4 shrink-0",
  label,
}: {
  status: SubagentLifecycleStatus;
  className?: string;
  label?: string;
}) {
  const a11y = label ? { "aria-label": label } : { "aria-hidden": true as const };
  switch (status) {
    case "running":
      return <LoaderCircleIcon {...a11y} className={`${className} animate-spin`} />;
    // waiting / blocked 是"在跑但等人或被挡"，不是结束态，所以共用暂停图标而不是终态图标。
    case "waiting":
    case "blocked":
      return <PauseCircleIcon {...a11y} className={className} />;
    case "success":
      return <CheckCircle2Icon {...a11y} className={className} />;
    case "failed":
      return <CircleAlertIcon {...a11y} className={className} />;
    case "cancelled":
      return <BanIcon {...a11y} className={className} />;
    case "lost":
      return <CircleDashedIcon {...a11y} className={className} />;
  }
}
