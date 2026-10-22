// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LedgerPriceListResult } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { LedgerPriceDialog } from "@/settings/usage-stats/ledger/LedgerPriceDialog.js";

// 契约：价格管理对话框列出合并表（带来源）、可编辑用户覆盖价、可维护别名映射。

const PRICE_LIST: LedgerPriceListResult = {
  entries: [
    {
      modelId: "deepseek-v4.1-flash",
      input: 0.15,
      output: 0.6,
      cacheRead: 0.003,
      source: "builtin",
      aliasOf: null,
    },
    {
      modelId: "relay-model",
      input: 1,
      output: 2,
      cacheRead: 0.5,
      source: "user",
      aliasOf: null,
    },
  ],
  total: 2,
  aliases: [{ alias: "alias-model", target: "relay-model", resolved: true }],
  meta: { currency: "USD" },
};

function createServices() {
  const service = {
    listLedgerPrices: vi.fn(async () => PRICE_LIST),
    setLedgerPrice: vi.fn(async () => ({ ok: true })),
    deleteLedgerPrice: vi.fn(async () => ({ ok: true })),
    setLedgerPriceAlias: vi.fn(async () => ({ ok: true })),
    getLedgerSnapshot: vi.fn(),
    syncLedgerPrices: vi.fn(),
  };
  return {
    service,
    accessor: { usageLedgerService: service } as unknown as IServiceAccessor,
  };
}

function renderDialog(onChanged = vi.fn()) {
  const { service, accessor } = createServices();
  render(
    createElement(
      ServiceProvider,
      { services: accessor },
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(LedgerPriceDialog, {
          open: true,
          onOpenChange: vi.fn(),
          unpricedModelIds: ["unknown-model"],
          onChanged,
        }),
      ),
    ),
  );
  return { service, onChanged };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("LedgerPriceDialog", () => {
  it("列出合并表、来源徽标与别名映射", async () => {
    renderDialog();
    await screen.findByText("relay-model");
    expect(screen.getByText("deepseek-v4.1-flash")).toBeTruthy();
    expect(screen.getAllByText("内置").length).toBeGreaterThan(0);
    expect(screen.getAllByText("自定义").length).toBeGreaterThan(0);
    expect(screen.getByTitle("alias-model → relay-model")).toBeTruthy();
    // 未计价模型入口
    expect(screen.getByText("unknown-model")).toBeTruthy();
  });

  it("编辑用户覆盖价后调用 setLedgerPrice 并刷新快照", async () => {
    const { service, onChanged } = renderDialog();
    const row = (await screen.findByText("relay-model")).closest("tr");
    expect(row).toBeTruthy();
    fireEvent.click(within(row as HTMLElement).getByText("编辑"));
    const inputs = within(row as HTMLElement).getAllByRole("textbox");
    fireEvent.change(inputs[0] as HTMLElement, { target: { value: "3" } });
    fireEvent.change(inputs[1] as HTMLElement, { target: { value: "4" } });
    fireEvent.change(inputs[2] as HTMLElement, { target: { value: "0.6" } });
    fireEvent.click(within(row as HTMLElement).getByText("保存"));
    await waitFor(() =>
      expect(service.setLedgerPrice).toHaveBeenCalledWith({
        modelId: "relay-model",
        input: 3,
        output: 4,
        cacheRead: 0.6,
      }),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("恢复默认只对用户覆盖价出现并调用 deleteLedgerPrice", async () => {
    const { service } = renderDialog();
    const userRow = (await screen.findByText("relay-model")).closest("tr") as HTMLElement;
    const builtinRow = screen.getByText("deepseek-v4.1-flash").closest("tr") as HTMLElement;
    expect(within(builtinRow).queryByText("恢复默认")).toBeNull();
    fireEvent.click(within(userRow).getByText("恢复默认"));
    await waitFor(() =>
      expect(service.deleteLedgerPrice).toHaveBeenCalledWith({ modelId: "relay-model" }),
    );
  });

  it("添加别名调用 setLedgerPriceAlias", async () => {
    const { service } = renderDialog();
    await screen.findByText("relay-model");
    fireEvent.change(screen.getByLabelText("别名"), { target: { value: "new-alias" } });
    fireEvent.change(screen.getByLabelText("目标模型"), { target: { value: "relay-model" } });
    fireEvent.click(screen.getByText("添加"));
    await waitFor(() =>
      expect(service.setLedgerPriceAlias).toHaveBeenCalledWith({
        alias: "new-alias",
        target: "relay-model",
      }),
    );
  });
});
