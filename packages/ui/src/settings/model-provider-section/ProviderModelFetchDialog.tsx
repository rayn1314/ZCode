import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import type { FetchedProviderModel, ProviderModelFetchDialogProps } from "@zcode/services";
import {
  TID_MODEL_PROVIDER_FETCH_MODELS_ADD_BUTTON,
  TID_MODEL_PROVIDER_FETCH_MODELS_DIALOG,
  TID_MODEL_PROVIDER_FETCH_MODELS_RETRY_BUTTON,
  TID_MODEL_PROVIDER_FETCH_MODELS_SEARCH_INPUT,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { ScrollArea } from "@/components/ui/scroll-area.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ModelCategory } from "./ProviderModelFetchCategory.js";
import { getModelCategory, groupModelsByCategory } from "./providerModelFetchCategories.js";

/** 与 ProviderModelFetchErrorCode 对应的可本地化错误码（RPC 只透传 code 字符串）。 */
const FETCH_MODELS_ERROR_CODES = [
  "missing-config",
  "auth",
  "not-found",
  "timeout",
  "parse",
  "http",
  "network",
] as const;
type FetchModelsErrorCode = (typeof FETCH_MODELS_ERROR_CODES)[number];

function isFetchModelsErrorCode(value: unknown): value is FetchModelsErrorCode {
  return (
    typeof value === "string" && (FETCH_MODELS_ERROR_CODES as readonly string[]).includes(value)
  );
}

// props 形状的唯一来源是 services 契约（`ProviderModelFetchDialogProps`，经 @zcode/services 出口）。
export function ProviderModelFetchDialog({
  open,
  onOpenChange,
  providerId,
  baseUrl,
  apiKey,
  apiFormat,
  configuredModelIds,
  fetchModels,
  onAddModels,
}: ProviderModelFetchDialogProps) {
  const { intl } = useZCodeIntl();
  const [models, setModels] = useState<readonly FetchedProviderModel[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorCode, setErrorCode] = useState<FetchModelsErrorCode | "generic" | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"new" | "existing">("new");
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(() => new Set());

  const configuredIds = useMemo(() => new Set(configuredModelIds), [configuredModelIds]);

  const runFetch = useCallback(async () => {
    setLoading(true);
    setErrorCode(null);
    setErrorMessage(null);
    try {
      const result = await fetchModels({ providerId, baseUrl, apiKey, apiFormat });
      setModels(result.models);
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      setErrorCode(isFetchModelsErrorCode(code) ? code : "generic");
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [apiFormat, apiKey, baseUrl, fetchModels, providerId]);

  // 每次打开弹窗都重新拉取，避免沿用上一供应商/上一次的列表。
  useEffect(() => {
    if (!open) return;
    setModels(null);
    setSearch("");
    setSelectedIds(new Set());
    setAddError(null);
    setActiveTab("new");
    setCollapsedGroups(new Set());
    void runFetch();
  }, [open, runFetch]);

  const formatError = (code: FetchModelsErrorCode | "generic", message: string): string => {
    if (code === "generic") {
      return intl.formatMessage(
        { id: "settings.modelProvider.fetchModelsError.generic" },
        { message },
      );
    }
    return intl.formatMessage({ id: `settings.modelProvider.fetchModelsError.${code}` });
  };

  // 搜索同时匹配模型 ID 与分组名；搜索时自动展开所有分组。
  const keyword = search.trim().toLowerCase();
  const isCollapsed = (category: string) =>
    keyword.length > 0 ? false : collapsedGroups.has(category);

  const filteredModels = useMemo(() => {
    if (!models) return [];
    if (!keyword) return models;
    return models.filter(
      (model) =>
        model.id.toLowerCase().includes(keyword) ||
        getModelCategory(model).toLowerCase().includes(keyword),
    );
  }, [keyword, models]);

  const newModels = useMemo(
    () => filteredModels.filter((model) => !configuredIds.has(model.id)),
    [configuredIds, filteredModels],
  );
  const existingModels = useMemo(
    () => filteredModels.filter((model) => configuredIds.has(model.id)),
    [configuredIds, filteredModels],
  );
  const newGroups = useMemo(() => groupModelsByCategory(newModels), [newModels]);
  const existingGroups = useMemo(() => groupModelsByCategory(existingModels), [existingModels]);

  // 拉取结果全是已配置模型时，默认落在「已有模型」Tab。
  useEffect(() => {
    if (activeTab === "new" && newModels.length === 0 && existingModels.length > 0) {
      setActiveTab("existing");
    }
  }, [activeTab, existingModels.length, newModels.length]);

  const toggleModel = (modelId: string) => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(modelId)) next.delete(modelId);
      else next.add(modelId);
      return next;
    });
  };

  const toggleGroup = (models: readonly FetchedProviderModel[]) => {
    const selectable = models.filter((model) => !configuredIds.has(model.id));
    if (selectable.length === 0) return;
    const allSelected = selectable.every((model) => selectedIds.has(model.id));
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (allSelected) {
        for (const model of selectable) next.delete(model.id);
      } else {
        for (const model of selectable) next.add(model.id);
      }
      return next;
    });
  };

  const handleAdd = async () => {
    if (!onAddModels) return;
    const toAdd = [...selectedIds].filter((id) => !configuredIds.has(id));
    if (toAdd.length === 0) return;
    setAdding(true);
    setAddError(null);
    try {
      await onAddModels(toAdd);
      onOpenChange(false);
    } catch (error) {
      setAddError(error instanceof Error ? error.message : String(error));
    } finally {
      setAdding(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-2xl"
        data-testid={TID_MODEL_PROVIDER_FETCH_MODELS_DIALOG}
        onOpenAutoFocus={(event) => {
          // 打开时搜索框尚未渲染（加载中），默认聚焦会落到关闭按钮上；先阻止，
          // 加载完成后用户可直接点击搜索框，避免焦点在弹窗内容切换时乱跳。
          event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {intl.formatMessage({ id: "settings.modelProvider.fetchModels" })}
          </DialogTitle>
          <DialogDescription>
            {models
              ? intl.formatMessage(
                  { id: "settings.modelProvider.fetchModelsTitle" },
                  { count: models.length },
                )
              : intl.formatMessage({ id: "settings.modelProvider.fetchModelsLoading" })}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex h-48 items-center justify-center gap-2 text-foreground-subtle">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            <span className="text-ui-sm">
              {intl.formatMessage({ id: "settings.modelProvider.fetchModelsLoading" })}
            </span>
          </div>
        ) : errorCode !== null ? (
          <div className="space-y-3">
            <p className="text-ui-sm text-destructive" role="alert">
              {formatError(errorCode, errorMessage ?? "")}
            </p>
            <div className="flex justify-end">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                data-testid={TID_MODEL_PROVIDER_FETCH_MODELS_RETRY_BUTTON}
                onClick={() => void runFetch()}
              >
                <RefreshCw data-icon="inline-start" aria-hidden="true" />
                {intl.formatMessage({ id: "settings.modelProvider.fetchModelsRetry" })}
              </Button>
            </div>
          </div>
        ) : models && models.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "settings.modelProvider.fetchModelsNoModels" })}
          </div>
        ) : models ? (
          <div className="space-y-3">
            <Input
              data-testid={TID_MODEL_PROVIDER_FETCH_MODELS_SEARCH_INPUT}
              type="text"
              size="lg"
              value={search}
              placeholder={intl.formatMessage({
                id: "settings.modelProvider.fetchModelsSearchPlaceholder",
              })}
              onChange={(event) => setSearch(event.target.value)}
            />
            <Tabs
              value={activeTab}
              onValueChange={(value) => {
                if (value === "new" || value === "existing") setActiveTab(value);
              }}
            >
              <TabsList className="w-full">
                <TabsTrigger value="new" disabled={newModels.length === 0} className="flex-1">
                  {intl.formatMessage(
                    { id: "settings.modelProvider.fetchModelsTabNew" },
                    { count: newModels.length },
                  )}
                </TabsTrigger>
                <TabsTrigger
                  value="existing"
                  disabled={existingModels.length === 0}
                  className="flex-1"
                >
                  {intl.formatMessage(
                    { id: "settings.modelProvider.fetchModelsTabExisting" },
                    { count: existingModels.length },
                  )}
                </TabsTrigger>
              </TabsList>
              <ScrollArea className="h-72" type="auto">
                <TabsContent value="new" className="mt-2 space-y-2 pr-3">
                  {newGroups.length === 0 ? (
                    <p className="py-6 text-center text-ui-sm text-foreground-subtle">
                      {intl.formatMessage({ id: "settings.modelProvider.fetchModelsEmpty" })}
                    </p>
                  ) : (
                    newGroups.map(([category, groupModels]) => (
                      <ModelCategory
                        key={category}
                        name={category}
                        models={groupModels}
                        selectedIds={selectedIds}
                        configuredIds={configuredIds}
                        collapsed={isCollapsed(category)}
                        onToggleCollapsed={() =>
                          setCollapsedGroups((previous) => {
                            const next = new Set(previous);
                            if (next.has(category)) next.delete(category);
                            else next.add(category);
                            return next;
                          })
                        }
                        onToggleModel={toggleModel}
                        onToggleGroup={toggleGroup}
                        adding={adding}
                      />
                    ))
                  )}
                </TabsContent>
                <TabsContent value="existing" className="mt-2 space-y-2 pr-3">
                  {existingGroups.length === 0 ? (
                    <p className="py-6 text-center text-ui-sm text-foreground-subtle">
                      {intl.formatMessage({ id: "settings.modelProvider.fetchModelsEmpty" })}
                    </p>
                  ) : (
                    existingGroups.map(([category, groupModels]) => (
                      <ModelCategory
                        key={category}
                        name={category}
                        models={groupModels}
                        selectedIds={selectedIds}
                        configuredIds={configuredIds}
                        collapsed={isCollapsed(category)}
                        onToggleCollapsed={() =>
                          setCollapsedGroups((previous) => {
                            const next = new Set(previous);
                            if (next.has(category)) next.delete(category);
                            else next.add(category);
                            return next;
                          })
                        }
                        onToggleModel={toggleModel}
                        onToggleGroup={toggleGroup}
                        adding={adding}
                      />
                    ))
                  )}
                </TabsContent>
              </ScrollArea>
            </Tabs>
            <div className="flex items-center justify-between gap-2">
              <p className="text-ui-xs text-foreground-subtle">
                {intl.formatMessage(
                  { id: "settings.modelProvider.fetchModelsSelectedCount" },
                  { count: selectedIds.size },
                )}
              </p>
              {addError ? (
                <p className="text-ui-sm text-destructive" role="alert">
                  {addError}
                </p>
              ) : null}
              <Button
                type="button"
                variant="secondary"
                size="default"
                className="rounded-lg"
                disabled={selectedIds.size === 0 || adding || !onAddModels}
                data-testid={TID_MODEL_PROVIDER_FETCH_MODELS_ADD_BUTTON}
                onClick={() => void handleAdd()}
              >
                {adding ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
                {intl.formatMessage(
                  { id: "settings.modelProvider.fetchModelsAddSelected" },
                  { count: selectedIds.size },
                )}
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
