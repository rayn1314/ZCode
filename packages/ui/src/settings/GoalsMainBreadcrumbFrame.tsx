import { useState, type ReactNode } from "react";
import {
  SettingsBreadcrumbProvider,
  SettingsHeaderBreadcrumb,
  type SettingsBreadcrumbItem,
} from "@/settings/SettingsHeaderBreadcrumb.js";

/**
 * 工作区「任务」主视图不经过 SettingsPage，编辑页的面包屑上报需要 Provider 接收，
 * 因此桌面上与 Automations 共用同一套面包屑合同（同形组件，避免参数化改动波及定时任务）。
 */
export function GoalsMainBreadcrumbFrame({
  ariaLabel,
  children,
  isDesktop,
  sectionLabel,
}: {
  ariaLabel: string;
  children: ReactNode;
  isDesktop: boolean;
  sectionLabel: string;
}) {
  const [items, setItems] = useState<readonly SettingsBreadcrumbItem[]>([]);

  return (
    <SettingsBreadcrumbProvider onItemsChange={setItems} sectionLabel={sectionLabel}>
      <div className="flex min-h-0 flex-1 flex-col">
        {isDesktop ? (
          <div className="h-12 shrink-0 [app-region:drag]" data-testid="goals-main-drag-region">
            <SettingsHeaderBreadcrumb ariaLabel={ariaLabel} items={items} />
          </div>
        ) : null}
        {children}
      </div>
    </SettingsBreadcrumbProvider>
  );
}
