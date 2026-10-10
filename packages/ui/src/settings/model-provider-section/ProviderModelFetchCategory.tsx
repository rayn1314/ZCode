import { ChevronDown } from "lucide-react";
import type { FetchedProviderModel } from "@zcode/services";
import { TID_MODEL_PROVIDER_FETCH_MODELS_ITEM, testId } from "@zcode/shared";
import { Checkbox } from "@/components/ui/checkbox.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";

/**
 * 单个供应商分组的折叠卡片（借鉴 new-api 的 ModelCategory）：
 * 组头是「全选 Checkbox + 组名 + 已选/总数 + 折叠箭头」，组内模型多列网格。
 */
export function ModelCategory({
  name,
  models,
  selectedIds,
  configuredIds,
  collapsed,
  onToggleCollapsed,
  onToggleModel,
  onToggleGroup,
  adding,
}: {
  name: string;
  models: readonly FetchedProviderModel[];
  selectedIds: ReadonlySet<string>;
  configuredIds: ReadonlySet<string>;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onToggleModel: (modelId: string) => void;
  onToggleGroup: (models: readonly FetchedProviderModel[]) => void;
  adding: boolean;
}) {
  const { intl } = useZCodeIntl();
  const categoryLabel =
    name === "other" ? intl.formatMessage({ id: "settings.modelProvider.fetchModelsOther" }) : name;
  const selectableModels = models.filter((model) => !configuredIds.has(model.id));
  const selectedCount = selectableModels.filter((model) => selectedIds.has(model.id)).length;
  const allSelected = selectableModels.length > 0 && selectedCount === selectableModels.length;
  const someSelected = selectedCount > 0 && !allSelected;

  return (
    <Collapsible open={!collapsed} onOpenChange={onToggleCollapsed} className="rounded-lg border">
      <div className="flex items-center gap-3 px-3">
        <Checkbox
          aria-label={`${categoryLabel} ${models.length}`}
          checked={someSelected ? "indeterminate" : allSelected}
          disabled={selectableModels.length === 0 || adding}
          onCheckedChange={() => onToggleGroup(selectableModels)}
          className="shrink-0"
        />
        <CollapsibleTrigger className="flex min-w-0 flex-1 items-center justify-between gap-2 py-2">
          <span className="min-w-0 flex-1 truncate text-ui-sm font-medium">
            {categoryLabel} ({models.length})
          </span>
          <span className="ml-auto shrink-0 text-ui-xs text-foreground-subtle">
            {selectedCount} / {selectableModels.length}
          </span>
          <ChevronDown
            className={cn(
              "size-4 shrink-0 text-foreground-subtle transition-transform duration-200",
              !collapsed && "rotate-180",
            )}
            aria-hidden="true"
          />
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent className="border-t px-3 py-2">
        <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
          {models.map((model) => {
            const isConfigured = configuredIds.has(model.id);
            const isSelected = selectedIds.has(model.id);
            return (
              <label
                key={model.id}
                data-testid={testId(TID_MODEL_PROVIDER_FETCH_MODELS_ITEM, model.id)}
                className={cn(
                  "flex min-w-0 cursor-pointer items-start gap-2 rounded-md px-1 py-1 hover:bg-hover",
                  isConfigured && "cursor-default hover:bg-transparent",
                )}
              >
                <Checkbox
                  aria-label={model.id}
                  checked={isConfigured || isSelected}
                  disabled={isConfigured || adding}
                  onCheckedChange={() => {
                    if (!isConfigured) onToggleModel(model.id);
                  }}
                  className="mt-0.5 shrink-0"
                />
                <span className="min-w-0 flex-1 break-all text-ui-sm">{model.id}</span>
                {isConfigured ? (
                  <span className="shrink-0 text-ui-xs text-foreground-subtle">
                    {intl.formatMessage({ id: "settings.modelProvider.fetchModelsAlreadyAdded" })}
                  </span>
                ) : null}
              </label>
            );
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
