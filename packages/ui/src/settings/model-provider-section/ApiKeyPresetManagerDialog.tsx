import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { TECHNICAL_INPUT_ATTRIBUTES } from "@/lib/technicalInputAttributes.js";
import { SettingsResourceList } from "@/settings/SettingsResourceGroup.js";
import { settingsResourceRowInteraction } from "@/settings/settingsResourceRowInteraction.js";
import { ApiKeyInput } from "./ApiKeyInput.js";
import {
  createApiKeyPreset,
  findActiveApiKeyPreset,
  maskApiKey,
  type ApiKeyPreset,
} from "./apiKeyPreset.js";

type PresetFormState = { mode: "create" } | { mode: "edit"; presetId: string };

/**
 * 预设管理弹窗（二级形态）：列表 = 应用/编辑/删除，表单 = 新建/改备注与 Key。
 * 增删改统一整组回写 `apiKeyPresets`，由调用方走既有保存链落盘。
 */
export function ApiKeyPresetManagerDialog({
  open,
  onOpenChange,
  presets,
  currentApiKey,
  onApply,
  onSavePresets,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  presets: readonly ApiKeyPreset[];
  currentApiKey: string;
  onApply: (apiKey: string) => void;
  onSavePresets: (presets: ApiKeyPreset[]) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const [form, setForm] = useState<PresetFormState | null>(null);
  const [nameValue, setNameValue] = useState("");
  const [keyValue, setKeyValue] = useState("");
  const [keyVisible, setKeyVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  const resetTransientState = () => {
    setForm(null);
    setNameValue("");
    setKeyValue("");
    setError(null);
    setConfirmingDeleteId(null);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) resetTransientState();
    onOpenChange(nextOpen);
  };

  const openCreate = () => {
    setForm({ mode: "create" });
    setNameValue("");
    setKeyValue("");
    setError(null);
  };

  const openEdit = (preset: ApiKeyPreset) => {
    setForm({ mode: "edit", presetId: preset.id });
    setNameValue(preset.name);
    setKeyValue(preset.apiKey);
    setKeyVisible(false);
    setError(null);
    setConfirmingDeleteId(null);
  };

  const commitForm = async () => {
    if (saving || !form) return;
    const name = nameValue.trim();
    const key = keyValue.trim();
    if (!name) {
      setError(intl.formatMessage({ id: "settings.modelProvider.apiKeyPreset.nameRequired" }));
      return;
    }
    if (!key) {
      setError(intl.formatMessage({ id: "settings.modelProvider.apiKeyPreset.keyRequired" }));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const next =
        form.mode === "create"
          ? [...presets, createApiKeyPreset(name, key)]
          : presets.map((preset) =>
              preset.id === form.presetId ? { ...preset, name, apiKey: key } : preset,
            );
      await onSavePresets(next);
      resetTransientState();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (presetId: string) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSavePresets(presets.filter((preset) => preset.id !== presetId));
      setConfirmingDeleteId(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const activePreset = findActiveApiKeyPreset(presets, currentApiKey);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="w-[min(480px,calc(100vw-2rem))] max-w-none">
        <DialogHeader>
          <DialogTitle>
            {intl.formatMessage({ id: "settings.modelProvider.apiKeyPreset.label" })}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "settings.modelProvider.apiKeyPreset.description" })}
          </DialogDescription>
        </DialogHeader>

        {form === null ? (
          <>
            {presets.length > 0 ? (
              <SettingsResourceList
                getKey={(preset) => preset.id}
                items={presets}
                renderItem={(preset) => {
                  const isActive = activePreset?.id === preset.id;
                  return (
                    <div
                      {...settingsResourceRowInteraction(() => openEdit(preset))}
                      className="flex items-center justify-between gap-3 px-4 py-3"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-ui-base text-foreground">{preset.name}</div>
                        <div className="truncate font-mono text-ui-sm text-foreground-subtle">
                          {maskApiKey(preset.apiKey)}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {isActive ? (
                          <span className="rounded-md bg-secondary px-1.5 py-0.5 text-ui-sm text-foreground-subtle">
                            {intl.formatMessage({
                              id: "settings.modelProvider.apiKeyPreset.active",
                            })}
                          </span>
                        ) : (
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            disabled={saving}
                            onClick={() => onApply(preset.apiKey)}
                          >
                            {intl.formatMessage({
                              id: "settings.modelProvider.apiKeyPreset.apply",
                            })}
                          </Button>
                        )}
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={intl.formatMessage({
                            id: "settings.modelProvider.apiKeyPreset.edit",
                          })}
                          disabled={saving}
                          onClick={() => openEdit(preset)}
                        >
                          <Pencil className="size-3.5" />
                        </Button>
                        {confirmingDeleteId === preset.id ? (
                          <Button
                            type="button"
                            variant="destructive"
                            size="xs"
                            disabled={saving}
                            onClick={() => void handleDelete(preset.id)}
                          >
                            {intl.formatMessage({
                              id: "settings.modelProvider.apiKeyPreset.deleteConfirm",
                            })}
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={intl.formatMessage({ id: "common.delete" })}
                            disabled={saving}
                            onClick={() => setConfirmingDeleteId(preset.id)}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                }}
              />
            ) : (
              <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "settings.modelProvider.apiKeyPreset.empty" })}
              </div>
            )}
            {error ? <p className="text-ui-sm text-destructive">{error}</p> : null}
            <div className="flex justify-end">
              <Button type="button" variant="outline" size="lg" onClick={openCreate}>
                <Plus data-icon="inline-start" aria-hidden="true" />
                {intl.formatMessage({ id: "settings.modelProvider.apiKeyPreset.create" })}
              </Button>
            </div>
          </>
        ) : (
          <>
            <div>
              <label className="mb-1 block text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "settings.modelProvider.apiKeyPreset.nameLabel" })}
              </label>
              <Input
                {...TECHNICAL_INPUT_ATTRIBUTES}
                type="text"
                size="lg"
                autoFocus
                value={nameValue}
                placeholder={intl.formatMessage({
                  id: "settings.modelProvider.apiKeyPreset.namePlaceholder",
                })}
                onChange={(event) => {
                  setNameValue(event.target.value);
                  setError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void commitForm();
                  }
                }}
              />
            </div>
            <div>
              <label className="mb-1 block text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "settings.modelProvider.apiKeyPreset.keyLabel" })}
              </label>
              <ApiKeyInput
                value={keyValue}
                visible={keyVisible}
                onChange={(value) => {
                  setKeyValue(value);
                  setError(null);
                }}
                onBlur={() => undefined}
                onToggleVisibility={() => setKeyVisible((value) => !value)}
              />
              {form.mode === "create" && currentApiKey ? (
                <div className="mt-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setKeyValue(currentApiKey)}
                  >
                    {intl.formatMessage({
                      id: "settings.modelProvider.apiKeyPreset.createFromCurrent",
                    })}
                  </Button>
                </div>
              ) : null}
            </div>
            {error ? <p className="text-ui-sm text-destructive">{error}</p> : null}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="lg"
                disabled={saving}
                onClick={resetTransientState}
              >
                {intl.formatMessage({ id: "common.cancel" })}
              </Button>
              <Button type="button" size="lg" disabled={saving} onClick={() => void commitForm()}>
                {intl.formatMessage({ id: "common.save" })}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
