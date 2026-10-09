import { ChevronDownIcon, Plus, Settings } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { findActiveApiKeyPreset, maskApiKey, type ApiKeyPreset } from "./apiKeyPreset.js";

/**
 * API Key 下方的预设切换行：选中即把预设 Key 写进生效 `apiKey`（调用方负责立即保存）。
 * 无预设时只留一个新建入口，避免空下拉让用户费脑子。
 */
export function ApiKeyPresetSwitcher({
  presets,
  currentApiKey,
  onApply,
  onManage,
}: {
  presets: readonly ApiKeyPreset[];
  currentApiKey: string;
  onApply: (apiKey: string) => void;
  onManage: () => void;
}) {
  const { intl } = useZCodeIntl();
  const activePreset = findActiveApiKeyPreset(presets, currentApiKey);
  const triggerLabel = activePreset
    ? activePreset.name
    : intl.formatMessage({ id: "settings.modelProvider.apiKeyPreset.customKey" });

  return (
    <div data-testid="model-provider-api-key-preset-switcher">
      <label className="mb-1 block text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.modelProvider.apiKeyPreset.label" })}
      </label>
      <div className="flex items-center gap-2">
        {presets.length === 0 ? (
          <Button type="button" variant="outline" size="lg" onClick={onManage}>
            <Plus data-icon="inline-start" aria-hidden="true" />
            {intl.formatMessage({ id: "settings.modelProvider.apiKeyPreset.create" })}
          </Button>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="min-w-0 max-w-56"
                data-testid="model-provider-api-key-preset-trigger"
                aria-label={intl.formatMessage({
                  id: "settings.modelProvider.apiKeyPreset.switchAria",
                })}
              >
                <span className="min-w-0 truncate">{triggerLabel}</span>
                <ChevronDownIcon data-icon="inline-end" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              <DropdownMenuRadioGroup
                value={activePreset?.id ?? ""}
                onValueChange={(id) => {
                  const preset = presets.find((item) => item.id === id);
                  if (preset) onApply(preset.apiKey);
                }}
              >
                {presets.map((preset) => (
                  <DropdownMenuRadioItem key={preset.id} value={preset.id}>
                    <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                      <span className="min-w-0 truncate">{preset.name}</span>
                      <span className="shrink-0 font-mono text-ui-sm text-foreground-subtle">
                        {maskApiKey(preset.apiKey)}
                      </span>
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onManage}>
                <Settings className="size-3.5" />
                {intl.formatMessage({ id: "settings.modelProvider.apiKeyPreset.manage" })}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {presets.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-lg"
            data-testid="model-provider-api-key-preset-manage-button"
            aria-label={intl.formatMessage({ id: "settings.modelProvider.apiKeyPreset.manage" })}
            onClick={onManage}
          >
            <Settings className="size-4" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
