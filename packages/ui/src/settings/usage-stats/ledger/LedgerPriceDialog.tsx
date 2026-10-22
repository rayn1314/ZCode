import { useEffect, useState } from "react";
import type { LedgerPriceEntry } from "@zcode/shared";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useLedgerPrices } from "@/hooks/useLedgerPrices.js";
import { LedgerPriceAliasSection } from "./LedgerPriceAliasSection.js";

const SOURCE_LABEL_KEY: Record<LedgerPriceEntry["source"], string> = {
  builtin: "settings.usage.ledger.prices.source.builtin",
  synced: "settings.usage.ledger.prices.source.synced",
  user: "settings.usage.ledger.prices.source.user",
};

interface PriceForm {
  modelId: string;
  input: string;
  output: string;
  cacheRead: string;
}

function formFromEntry(entry: LedgerPriceEntry): PriceForm {
  return {
    modelId: entry.modelId,
    input: String(entry.input),
    output: String(entry.output),
    cacheRead: String(entry.cacheRead),
  };
}

function parsePrice(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function PriceFields({
  form,
  onChange,
  autoFocus,
}: {
  form: PriceForm;
  onChange: (patch: Partial<PriceForm>) => void;
  autoFocus?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const fields: Array<{ key: "input" | "output" | "cacheRead"; labelId: string }> = [
    { key: "input", labelId: "settings.usage.ledger.prices.input" },
    { key: "output", labelId: "settings.usage.ledger.prices.output" },
    { key: "cacheRead", labelId: "settings.usage.ledger.prices.cacheRead" },
  ];
  return (
    <div className="grid grid-cols-3 gap-2">
      {fields.map((field, index) => (
        <Input
          key={field.key}
          size="xs"
          inputMode="decimal"
          autoFocus={autoFocus && index === 0}
          value={form[field.key]}
          onChange={(event) => onChange({ [field.key]: event.target.value })}
          placeholder={intl.formatMessage({ id: field.labelId })}
          aria-label={intl.formatMessage({ id: field.labelId })}
        />
      ))}
    </div>
  );
}

/**
 * 价格管理对话框：搜索合并表（内置 < 同步 < 用户覆盖）、逐行改价/恢复默认、
 * 顶部列出未计价模型直达补价、底部维护别名映射。
 * 写操作只动用户覆盖层，成功后重拉列表并刷新快照（费用口径跟着变）。
 */
export function LedgerPriceDialog({
  open,
  onOpenChange,
  unpricedModelIds,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  unpricedModelIds: string[];
  /** 价格变化后刷新账本快照。 */
  onChanged: () => void;
}) {
  const { intl } = useZCodeIntl();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [editing, setEditing] = useState<PriceForm | null>(null);
  const [creating, setCreating] = useState<PriceForm | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const prices = useLedgerPrices(debouncedQuery, open);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (open) {
      return;
    }
    setQuery("");
    setDebouncedQuery("");
    setEditing(null);
    setCreating(null);
    setFeedback(null);
  }, [open]);

  const invalidPriceMessage = intl.formatMessage({
    id: "settings.usage.ledger.prices.invalidPrice",
  });
  const saveFailedMessage = intl.formatMessage({ id: "settings.usage.ledger.prices.saveFailed" });

  const submitForm = async (form: PriceForm) => {
    const modelId = form.modelId.trim().toLowerCase();
    const input = parsePrice(form.input);
    const output = parsePrice(form.output);
    const cacheRead = parsePrice(form.cacheRead);
    if (!modelId || input === null || output === null || cacheRead === null) {
      setFeedback(invalidPriceMessage);
      return;
    }
    const result = await prices.setPrice(modelId, { input, output, cacheRead });
    if (!result.ok) {
      setFeedback(result.error ?? saveFailedMessage);
      return;
    }
    setFeedback(null);
    setEditing(null);
    setCreating(null);
    onChanged();
  };

  const resetPrice = async (entry: LedgerPriceEntry) => {
    const result = await prices.deletePrice(entry.modelId);
    if (!result.ok) {
      setFeedback(result.error ?? saveFailedMessage);
      return;
    }
    setFeedback(null);
    onChanged();
  };

  const currency = prices.meta?.currency === "CNY" ? "CNY" : "USD";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="ledger-price-dialog"
        className="flex max-h-[85vh] w-[min(820px,calc(100vw-2rem))] max-w-none flex-col gap-3"
      >
        <DialogTitle className="text-ui-lg font-medium text-foreground">
          {intl.formatMessage({ id: "settings.usage.ledger.prices.title" })}
        </DialogTitle>
        <DialogDescription className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "settings.usage.ledger.prices.description" }, { currency })}
        </DialogDescription>

        {unpricedModelIds.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "settings.usage.ledger.prices.unpricedTitle" })}
            </span>
            {unpricedModelIds.slice(0, 20).map((modelId) => (
              <Button
                key={modelId}
                type="button"
                size="xs"
                variant="outline"
                title={intl.formatMessage({ id: "settings.usage.ledger.prices.unpricedHint" })}
                onClick={() => setCreating({ modelId, input: "", output: "", cacheRead: "" })}
              >
                {modelId}
              </Button>
            ))}
          </div>
        ) : null}

        <div className="flex items-center gap-2">
          <Input
            size="sm"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={intl.formatMessage({ id: "settings.usage.ledger.prices.search" })}
            aria-label={intl.formatMessage({ id: "settings.usage.ledger.prices.search" })}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setEditing(null);
              setCreating({ modelId: "", input: "", output: "", cacheRead: "" });
            }}
          >
            {intl.formatMessage({ id: "settings.usage.ledger.prices.add" })}
          </Button>
        </div>

        {creating ? (
          <div className="space-y-2 rounded-lg border border-border p-2">
            <Input
              size="sm"
              autoFocus
              value={creating.modelId}
              onChange={(event) =>
                setCreating((current) =>
                  current ? { ...current, modelId: event.target.value } : current,
                )
              }
              placeholder={intl.formatMessage({ id: "settings.usage.ledger.prices.model" })}
              aria-label={intl.formatMessage({ id: "settings.usage.ledger.prices.model" })}
            />
            <PriceFields
              form={creating}
              onChange={(patch) =>
                setCreating((current) => (current ? { ...current, ...patch } : current))
              }
            />
            <div className="flex justify-end gap-2">
              <Button type="button" size="xs" variant="ghost" onClick={() => setCreating(null)}>
                {intl.formatMessage({ id: "settings.usage.ledger.prices.cancel" })}
              </Button>
              <Button type="button" size="xs" onClick={() => void submitForm(creating)}>
                {intl.formatMessage({ id: "settings.usage.ledger.prices.save" })}
              </Button>
            </div>
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {prices.unavailable ? (
            <p className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "settings.usage.ledger.unavailableTitle" })}
            </p>
          ) : (
            <table className="w-full border-collapse text-ui-base">
              <thead>
                <tr className="text-left text-ui-sm text-foreground-subtle">
                  <th className="py-1 pr-2 font-normal">
                    {intl.formatMessage({ id: "settings.usage.ledger.prices.model" })}
                  </th>
                  <th className="py-1 pr-2 font-normal">
                    {intl.formatMessage({ id: "settings.usage.ledger.prices.source" })}
                  </th>
                  <th className="py-1 pr-2 text-right font-normal">
                    {intl.formatMessage({ id: "settings.usage.ledger.prices.input" })}
                  </th>
                  <th className="py-1 pr-2 text-right font-normal">
                    {intl.formatMessage({ id: "settings.usage.ledger.prices.output" })}
                  </th>
                  <th className="py-1 pr-2 text-right font-normal">
                    {intl.formatMessage({ id: "settings.usage.ledger.prices.cacheRead" })}
                  </th>
                  <th className="py-1 font-normal" />
                </tr>
              </thead>
              <tbody>
                {prices.entries.map((entry) => {
                  const editingThis = editing?.modelId === entry.modelId;
                  return (
                    <tr key={entry.modelId} className="border-t border-border/60 align-top">
                      <td className="max-w-[240px] py-1.5 pr-2">
                        <div className="truncate font-mono" title={entry.modelId}>
                          {entry.modelId}
                        </div>
                        {entry.aliasOf ? (
                          <div className="truncate text-ui-sm text-foreground-subtle">
                            → {entry.aliasOf}
                          </div>
                        ) : null}
                      </td>
                      <td className="py-1.5 pr-2">
                        <Badge variant="outline">
                          {intl.formatMessage({ id: SOURCE_LABEL_KEY[entry.source] })}
                        </Badge>
                      </td>
                      {editingThis && editing ? (
                        <td colSpan={3} className="py-1.5 pr-2">
                          <PriceFields
                            form={editing}
                            autoFocus
                            onChange={(patch) =>
                              setEditing((current) =>
                                current ? { ...current, ...patch } : current,
                              )
                            }
                          />
                        </td>
                      ) : (
                        <>
                          <td className="py-1.5 pr-2 text-right tabular-nums">{entry.input}</td>
                          <td className="py-1.5 pr-2 text-right tabular-nums">{entry.output}</td>
                          <td className="py-1.5 pr-2 text-right tabular-nums">{entry.cacheRead}</td>
                        </>
                      )}
                      <td className="py-1.5 text-right whitespace-nowrap">
                        {editingThis && editing ? (
                          <>
                            <Button
                              type="button"
                              size="xs"
                              variant="ghost"
                              onClick={() => setEditing(null)}
                            >
                              {intl.formatMessage({ id: "settings.usage.ledger.prices.cancel" })}
                            </Button>
                            <Button
                              type="button"
                              size="xs"
                              onClick={() => void submitForm(editing)}
                            >
                              {intl.formatMessage({ id: "settings.usage.ledger.prices.save" })}
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              type="button"
                              size="xs"
                              variant="ghost"
                              onClick={() => {
                                setCreating(null);
                                setEditing(formFromEntry(entry));
                              }}
                            >
                              {intl.formatMessage({ id: "settings.usage.ledger.prices.edit" })}
                            </Button>
                            {entry.source === "user" ? (
                              <Button
                                type="button"
                                size="xs"
                                variant="ghost"
                                onClick={() => void resetPrice(entry)}
                              >
                                {intl.formatMessage({ id: "settings.usage.ledger.prices.reset" })}
                              </Button>
                            ) : null}
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {prices.loading ? (
            <p className="py-2 text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "settings.usage.ledger.loadingDescription" })}
            </p>
          ) : null}
          {!prices.loading && prices.total > prices.entries.length ? (
            <p className="py-2 text-ui-sm text-foreground-subtle">
              {intl.formatMessage(
                { id: "settings.usage.ledger.prices.total" },
                { total: prices.total, shown: prices.entries.length },
              )}
            </p>
          ) : null}
          {prices.error ? (
            <p className="py-2 text-ui-sm text-destructive" role="alert">
              {prices.error}
            </p>
          ) : null}
        </div>

        {feedback ? (
          <p className="text-ui-sm text-destructive" role="alert">
            {feedback}
          </p>
        ) : null}

        <LedgerPriceAliasSection
          aliases={prices.aliases}
          onSet={prices.setAlias}
          onChanged={onChanged}
          onError={setFeedback}
        />
      </DialogContent>
    </Dialog>
  );
}
