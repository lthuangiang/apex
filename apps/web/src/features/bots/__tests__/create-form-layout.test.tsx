// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { MmFee } from "@drift/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { BotForm } from "../components/bot-form";
import { CreateBot } from "../components/create-bot";
import { emptyValues, FIELDS, type FormValues } from "../fields";

// Bố cục form Create theo yêu cầu người dùng 2026-11-17 (DEC-295, không có canvas):
// Advanced settings đóng mặc định ở Market Making và Volume Builder, các hàng hai / ba ô, nhóm Order size (Min · Max),
// lỗi trong Advanced tự mở section, bảng bậc builder fee Market Making ngay dưới chart, Max loss Volume Builder 10.

const page = vi.hoisted(() => ({ mobile: false, mmFee: null as MmFee | null, rate: 3 }));

vi.mock("@/lib/markets", () => ({
  useMarketNames: () => ({ asset: (a: string) => a, market: (m: string) => m }),
  useMarkets: () => ({ data: { items: [] } }),
  useMarketLast: () => ({ data: undefined }),
}));
vi.mock("../components/market-picker", () => ({
  MarketPicker: ({ value }: { value: string }) => <span>{value}</span>,
}));
vi.mock("../components/amount-lines", () => ({ AmountLines: () => null }));
vi.mock("@/components/workspace-shell", () => ({
  WorkspaceShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock("@/components/not-connected", () => ({
  NotConnected: () => null,
  useSodexMissing: () => false,
}));
vi.mock("@/lib/queries", () => ({
  ME_KEY: ["me"],
  useMe: () => ({ data: { role: "user", timezone: "UTC", defaultMaxLossPct: null } }),
  useFeatures: () => ({ data: { mmFee: page.mmFee } }),
  useBuilderFeeRate: () => page.rate,
  useTwoFactorNeeded: () => false,
}));
vi.mock("@/lib/use-media", () => ({
  BELOW_LG: "(max-width: 1023px)",
  useMediaQuery: () => page.mobile,
}));
vi.mock("@/lib/api", () => ({
  ApiError: class extends Error {},
  api: () => new Promise(() => undefined),
}));
vi.mock("../components/ai-params", () => ({
  AiPanel: () => null,
  useAiParameters: () => ({
    enabled: false,
    state: {
      paramSource: "manual",
      mode: "manual",
      sources: {},
      placeholders: {},
      loading: false,
      needsCapital: false,
    },
  }),
}));
vi.mock("../components/start-checks", () => ({
  CheckList: () => null,
  leverageWarning: () => null,
  useDryRunChecks: () => ({
    query: { data: undefined, error: null },
    valid: false,
    invalidKeys: [],
  }),
}));
vi.mock("../components/visual-panel", () => ({
  VisualPanel: () => <div data-testid="visual" />,
}));
vi.mock("../components/market-chart", () => ({
  MarketChart: () => <div data-testid="market-chart" />,
}));
vi.mock("../components/mm-markets", () => ({ MmSuggestions: () => null }));

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  page.mobile = false;
  page.mmFee = null;
  page.rate = 3;
});
// jsdom không có scrollIntoView (form cuộn tới field lỗi).
Element.prototype.scrollIntoView = () => undefined;
vi.setConfig({ testTimeout: 20_000 });

function Harness({
  strategy,
  init,
  errors = {},
}: {
  strategy: keyof typeof FIELDS;
  init: FormValues;
  errors?: Record<string, string[]>;
}) {
  const [values, setValues] = useState<FormValues>(init);
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      <main>
        <BotForm strategy={strategy} values={values} onChange={setValues} errors={errors} />
      </main>
    </NextIntlClientProvider>
  );
}

const toggle = () => screen.getByRole("button", { name: /Advanced settings/ });
const must = (el: HTMLElement | null): HTMLElement => {
  if (el === null) throw new Error("element not found");
  return el;
};
const region = () => must(document.getElementById("advanced-settings"));
const insideAdvanced = (el: HTMLElement) => region().contains(el);
const rowOf = (name: string) => must(document.querySelector<HTMLElement>(`[data-row="${name}"]`));
const axeRun = async (container: HTMLElement) => {
  const r = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(" | ")}`)).toEqual([]);
};

const mmInit = (over: FormValues = {}): FormValues => ({
  ...emptyValues("volume_maker"),
  market: "BTC-USD",
  ...over,
});
const vbInit = (over: FormValues = {}): FormValues => ({
  ...emptyValues("volume_farm"),
  market: "BTC-USD",
  ...over,
});

describe("Advanced settings disclosure", () => {
  it.each(["volume_maker", "volume_farm"] as const)(
    "%s: a real button, closed by default, opens and closes on click",
    async (strategy) => {
      render(
        <Harness strategy={strategy} init={strategy === "volume_maker" ? mmInit() : vbInit()} />,
      );
      const btn = toggle();
      expect(btn.tagName).toBe("BUTTON");
      expect(btn).toHaveAttribute("aria-expanded", "false");
      expect(btn).toHaveAttribute("aria-controls", "advanced-settings");
      expect(region()).not.toBeVisible();
      await userEvent.click(btn);
      expect(btn).toHaveAttribute("aria-expanded", "true");
      expect(region()).toBeVisible();
      await userEvent.click(btn);
      expect(btn).toHaveAttribute("aria-expanded", "false");
      expect(region()).not.toBeVisible();
    },
  );
});

describe("Market Making layout", () => {
  it("keeps the stop fields outside on one row and moves Also stop at and the loss caps inside", () => {
    render(<Harness strategy="volume_maker" init={mmInit()} />);
    const budget = screen.getByLabelText("Stop when costs reach");
    const volume = screen.getByLabelText("Stop after this much volume (optional)");
    expect(insideAdvanced(budget)).toBe(false);
    expect(insideAdvanced(volume)).toBe(false);
    expect(insideAdvanced(screen.getByLabelText("Order size per side"))).toBe(false);
    expect(insideAdvanced(screen.getByRole("switch", { name: /Smart quoting/ }))).toBe(false);
    // Một hàng: hai cột từ md, xếp chồng dưới md.
    const row = rowOf("stop");
    expect(row).toContainElement(budget);
    expect(row).toContainElement(volume);
    expect(row).toHaveClass("grid-cols-1", "md:grid-cols-2");

    expect(
      insideAdvanced(screen.getByRole("radiogroup", { name: "Also stop at", hidden: true })),
    ).toBe(true);
    expect(insideAdvanced(screen.getByTestId("loss-caps"))).toBe(true);
    // Khối "How your losses are capped" ngay trên Max position ("set below").
    const caps = screen.getByTestId("loss-caps");
    const maxPos = screen.getByLabelText("Max position", { selector: "input" });
    expect(caps.compareDocumentPosition(maxPos) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("an error inside Advanced opens it and focuses the field", async () => {
    render(
      <Harness strategy="volume_maker" init={mmInit()} errors={{ maxOrders: ["Allowed 1–10."] }} />,
    );
    await waitFor(() => {
      expect(toggle()).toHaveAttribute("aria-expanded", "true");
    });
    const input = screen.getByLabelText("Max position", { selector: "input" });
    await waitFor(() => {
      expect(input).toHaveFocus();
    });
  });

  it("an error on the position loss limit (inside the loss caps block) opens Advanced", async () => {
    render(
      <Harness
        strategy="volume_maker"
        init={mmInit()}
        errors={{ inventoryLossStop: ["Must be below the budget."] }}
      />,
    );
    await waitFor(() => {
      expect(toggle()).toHaveAttribute("aria-expanded", "true");
    });
  });

  it("has no axe violations with Advanced closed and open", async () => {
    const { container } = render(<Harness strategy="volume_maker" init={mmInit()} />);
    await axeRun(container);
    await userEvent.click(toggle());
    await axeRun(container);
  });
});

describe("Volume Builder layout", () => {
  it("shows one Order size group (Min · Max) on the Leverage row, with full names for screen readers", () => {
    render(<Harness strategy="volume_farm" init={vbInit()} />);
    const min = screen.getByLabelText("Order size, min");
    const max = screen.getByLabelText("Order size, max");
    const lev = screen.getByLabelText("Leverage");
    const row = rowOf("size");
    expect(row).toContainElement(min);
    expect(row).toContainElement(max);
    expect(row).toContainElement(lev);
    // Min · Max · Leverage từ md; dưới md Min · Max cạnh nhau, Leverage xuống dưới.
    expect(row).toHaveClass("grid-cols-2", "md:grid-cols-3");
    const r = within(row);
    expect(r.getByText("Order size")).toBeInTheDocument();
    expect(r.getByText("Min", { selector: "label" })).toBeInTheDocument();
    expect(r.getByText("Max", { selector: "label" })).toBeInTheDocument();
    expect(screen.queryByText("Order size from")).toBeNull();
    expect(screen.queryByText("Order size to")).toBeNull();
    expect(min).toHaveValue("100");
    expect(max).toHaveValue("200");
  });

  it("puts Max loss and Stop at volume on one row, defaulting Max loss to 10", () => {
    render(<Harness strategy="volume_farm" init={vbInit()} />);
    const loss = screen.getByLabelText("Max loss for this bot");
    const volume = screen.getByLabelText("Stop at volume (optional)");
    const row = rowOf("stop");
    expect(row).toContainElement(loss);
    expect(row).toContainElement(volume);
    expect(row).toHaveClass("grid-cols-1", "md:grid-cols-2");
    expect(loss).toHaveValue("10");
    expect(emptyValues("volume_farm").maxLoss).toBe("10");
  });

  it("moves Hold … Stop loss on SoDEX into Advanced and keeps size, exits and stops outside", () => {
    render(<Harness strategy="volume_farm" init={vbInit()} />);
    for (const label of [
      "Order size, min",
      "Order size, max",
      "Leverage",
      "Take profit",
      "Stop loss",
      "Max loss for this bot",
      "Stop at volume (optional)",
    ])
      expect(insideAdvanced(screen.getByLabelText(label)), label).toBe(false);
    for (const label of ["Hold at least", "Hold at most"])
      expect(insideAdvanced(screen.getByLabelText(label)), label).toBe(true);
    for (const name of [/Reverse the signal/, /Only trade sideways/, /Stop loss on SoDEX/])
      expect(insideAdvanced(screen.getByRole("switch", { name, hidden: true })), String(name)).toBe(
        true,
      );
    // Section Strategy không còn field nào nên không hiện.
    expect(screen.queryByText("Strategy", { selector: "legend" })).toBeNull();
  });

  it("an error inside Advanced opens it and focuses the field", async () => {
    render(
      <Harness
        strategy="volume_farm"
        init={vbInit()}
        errors={{ minHoldSecs: ["Allowed 10–3600 s."] }}
      />,
    );
    await waitFor(() => {
      expect(toggle()).toHaveAttribute("aria-expanded", "true");
    });
    await waitFor(() => {
      expect(screen.getByLabelText("Hold at least")).toHaveFocus();
    });
  });

  it("has no axe violations with Advanced closed and open", async () => {
    const { container } = render(<Harness strategy="volume_farm" init={vbInit()} />);
    await axeRun(container);
    await userEvent.click(toggle());
    await axeRun(container);
  });
});

describe("Market Making builder fee under the chart", () => {
  const mm = (over: Partial<MmFee>): MmFee => ({
    rate: 3,
    source: "default",
    volume30d: null,
    nextVolume: "200000",
    nextRate: 2,
    ...over,
  });
  const showCreate = (strategy: keyof typeof FIELDS = "volume_maker") =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <CreateBot strategy={strategy} />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
  const ladderRows = (card: HTMLElement) => within(card).getAllByRole("row").slice(1);
  const before = () => screen.getByRole("region", { name: "Before it starts" });

  it("custom fee: Your builder fee + the custom sentence, the 3-tier ladder without You, no tier sentence below", () => {
    page.mmFee = mm({ source: "custom", rate: 1, volume30d: "500000" });
    page.rate = 1;
    showCreate();
    const card = screen.getByTestId("mm-fee-under-chart");
    expect(screen.getByTestId("market-chart").nextElementSibling).toBe(card);
    expect(within(card).getByText("Your builder fee")).toBeInTheDocument();
    expect(within(card).getByText(messages.bots.catalog.customFee)).toBeInTheDocument();
    expect(ladderRows(card)).toHaveLength(3);
    expect(within(card).queryByText("You")).toBeNull();
    expect(card.querySelector('[aria-current="true"]')).toBeNull();
    // "Before it starts": câu phí ngắn, không bảng bậc, không câu bậc.
    expect(within(before()).queryByRole("table")).toBeNull();
    expect(within(before()).getByText(/^Fees: SoDEX trading fee per fill/)).toBeInTheDocument();
    expect(within(before()).queryByText(/The rate drops to/)).toBeNull();
  });

  it("tier fee: You marks the current row", () => {
    page.mmFee = mm({ rate: 2, volume30d: "300000", nextVolume: "1000000", nextRate: 1 });
    page.rate = 2;
    showCreate();
    const card = screen.getByTestId("mm-fee-under-chart");
    expect(screen.getByTestId("market-chart").nextElementSibling).toBe(card);
    expect(ladderRows(card)).toHaveLength(3);
    const current = card.querySelector('[aria-current="true"]');
    expect(current).not.toBeNull();
    expect(current).toHaveTextContent("You");
    expect(within(card).getAllByText("You")).toHaveLength(1);
    expect(within(before()).queryByRole("table")).toBeNull();
    expect(within(before()).getByText(/The rate drops to/)).toBeInTheDocument();
  });

  it("default / no volume: the plain rate and the ladder", () => {
    page.mmFee = mm({});
    showCreate();
    const card = screen.getByTestId("mm-fee-under-chart");
    expect(within(card).getByText(/^Builder fee /)).toBeInTheDocument();
    expect(ladderRows(card)).toHaveLength(3);
    expect(within(card).queryByText("You")).toBeNull();
  });

  it("mobile: the ladder sits right under the inline chart", () => {
    page.mobile = true;
    page.mmFee = mm({ source: "custom", rate: 1 });
    showCreate();
    expect(screen.getByTestId("market-chart").nextElementSibling).toBe(
      screen.getByTestId("mm-fee-under-chart"),
    );
  });

  it("Volume Builder has no fee ladder", () => {
    showCreate("volume_farm");
    expect(screen.queryByTestId("mm-fee-under-chart")).toBeNull();
  });
});
