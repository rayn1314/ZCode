import { useState } from "react";
import type { LedgerPriceAlias, LedgerPriceMutationResult } from "@zcode/shared";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 别名映射区：别名按目标模型的价格计价。
 * 目标未定价时别名不生效（服务端 resolved=false），这里显式标「未解析」，
 * 避免用户配了别名却看不到任何费用变化。
 */
export function LedgerPriceAliasSection({
  aliases,
  onSet,
  onChanged,
  onError,
}: {
  aliases: LedgerPriceAlias[];
  onSet: (alias: string, target: string | null) => Promise<LedgerPriceMutationResult>;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const [alias, setAlias] = useState("");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (mutate: () => Promise<LedgerPriceMutationResult>, onSuccess?: () => void) => {
    setBusy(true);
    try {
      const result = await mutate();
      if (result.ok) {
        onSuccess?.();
        onChanged();
      } else {
        onError(
          result.error ?? intl.formatMessage({ id: "settings.usage.ledger.prices.saveFailed" }),
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    const nextAlias = alias.trim();
    const nextTarget = target.trim();
    if (!nextAlias || !nextTarget || nextAlias.toLowerCase() === nextTarget.toLowerCase()) {
      onError(intl.formatMessage({ id: "settings.usage.ledger.prices.alias.invalid" }));
      return;
    }
    void run(
      () => onSet(nextAlias, nextTarget),
      () => {
        setAlias("");
        setTarget("");
      },
    );
  };

  return (
    <div className="space-y-2 border-t border-border pt-3">
      <div>
        <div className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.usage.ledger.prices.alias.title" })}
        </div>
        <p className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "settings.usage.ledger.prices.alias.description" })}
        </p>
      </div>
      {aliases.length === 0 ? (
        <p className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "settings.usage.ledger.prices.alias.empty" })}
        </p>
      ) : (
        <div className="space-y-1">
          {aliases.map((item) => (
            <div
              key={item.alias}
              className="flex items-center gap-2 rounded-md bg-surface px-2 py-1"
            >
              <span
                className="min-w-0 flex-1 truncate font-mono text-ui-base text-foreground"
                title={`${item.alias} → ${item.target}`}
              >
                {item.alias} <span className="text-foreground-subtle">→</span> {item.target}
              </span>
              {item.resolved ? null : (
                <Badge variant="outline">
                  {intl.formatMessage({ id: "settings.usage.ledger.prices.alias.unresolved" })}
                </Badge>
              )}
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() => void run(() => onSet(item.alias, null))}
              >
                {intl.formatMessage({ id: "settings.usage.ledger.prices.alias.remove" })}
              </Button>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          size="sm"
          className="max-w-[220px]"
          value={alias}
          onChange={(event) => setAlias(event.target.value)}
          placeholder={intl.formatMessage({ id: "settings.usage.ledger.prices.alias.name" })}
          aria-label={intl.formatMessage({ id: "settings.usage.ledger.prices.alias.name" })}
        />
        <Input
          size="sm"
          className="max-w-[220px]"
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          placeholder={intl.formatMessage({ id: "settings.usage.ledger.prices.alias.target" })}
          aria-label={intl.formatMessage({ id: "settings.usage.ledger.prices.alias.target" })}
        />
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={submit}>
          {intl.formatMessage({ id: "settings.usage.ledger.prices.alias.add" })}
        </Button>
      </div>
    </div>
  );
}
