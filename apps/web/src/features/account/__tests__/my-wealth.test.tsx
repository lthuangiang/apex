// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { WealthMeResponse } from "@drift/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { ApiError } from "../../../lib/api";
import { PortfolioPage } from "../components/portfolio-page";

// Portfolio › My Wealth (#592, DEC-402): chỉ đọc; trường null → "Not provided", không bao giờ "0"; ví trống → empty
// state; chưa kết nối → mời kết nối; hết ngân sách weight (429 `sodex_wealth_budget`) → câu busy; công tắc
// `features.usMarket` tắt → không có tab. Dữ liệu là dữ liệu giả, không có địa chỉ ví.

type Reply = { kind: "ok"; body: unknown } | { kind: "error"; error: Error } | { kind: "pending" };

const state = vi.hoisted(() => ({
  usMarket: true,
  tab: "wealth" as string | null,
  wealth: { kind: "pending" } as Reply,
  calls: [] as string[],
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(state.tab === null ? "" : `tab=${state.tab}`),
}));
vi.mock("@/components/workspace", () => ({
  Workspace: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  PageHead: ({ title, subtitle }: { title: string; subtitle: ReactNode }) => (
    <header>
      <h1>{title}</h1>
      <p>{subtitle}</p>
    </header>
  ),
  Card: ({ title, children }: { title?: string; children: ReactNode }) => (
    <section aria-label={title}>
      {title === undefined ? null : <h2>{title}</h2>}
      {children}
    </section>
  ),
}));
vi.mock("@/components/not-connected", () => ({
  NotConnected: ({ message }: { message?: string }) => <p>{message}</p>,
  useSodexMissing: () => false,
}));
vi.mock("@/lib/queries", () => ({
  useFeatures: () => ({ data: { usMarket: state.usMarket } }),
}));
vi.mock("@/lib/markets", () => ({
  useMarketNames: () =>
    Object.assign((m: string) => m, {
      market: (m: string) => m,
      asset: (a: string) => a,
      info: () => undefined,
    }),
}));
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../lib/api")>();
  return {
    ...real,
    api: (_method: string, path: string) => {
      state.calls.push(path);
      if (path !== "/api/v1/wealth/me") return new Promise(() => undefined);
      const r = state.wealth;
      if (r.kind === "pending") return new Promise(() => undefined);
      if (r.kind === "error") return Promise.reject(r.error);
      return Promise.resolve(r.body);
    },
  };
});
vi.mock("@/features/desk/components/ask-about-this", () => ({ AskAboutThis: () => null }));
vi.mock("../components/charts", () => ({ Meter: () => null, ShareBar: () => null }));
vi.mock("../components/accounts-row", () => ({
  AccountsRow: () => null,
  CollateralTable: () => null,
}));

/** DataTable có hai vùng cùng tên (khung DataRegion và khung cuộn), như các bảng Portfolio sẵn có: lấy khung ngoài. */
const table = (name: string) => screen.getAllByRole("region", { name })[0] as HTMLElement;

type Ok = Extract<WealthMeResponse, { status: "ok" }>;

const full = (): Ok => ({
  status: "ok",
  readAt: "2026-11-28T03:00:00.000Z",
  summary: {
    currency: "USD",
    totalValue: "2662.72",
    settledValue: "2612.72",
    totalCost: "2680",
    totalPnl: "201.39",
    totalRealizedPnl: "218.67",
    totalUnrealizedPnl: "-17.28",
    totalPnl24h: "12.05",
    inFlightValue: "50",
    complete: true,
  },
  holdings: [
    {
      fundId: "FUND-A",
      name: "Sample Vault Fund",
      fundType: "escrow_vault",
      shares: "1484.31",
      price: "1.01",
      marketValue: "1499.72",
      avgCost: "1",
      unrealizedPnl: "19.72",
      realizedPnl: "0",
      pnl24h: "0.18",
      pendingRedeemShares: "0",
      pendingDepositShares: "0",
      priced: true,
    },
    {
      fundId: "FUND-B",
      name: "Sample Redeeming Fund",
      fundType: "bridged_vault",
      shares: "33.63",
      price: "4.94",
      marketValue: "166.05",
      avgCost: "5.95",
      unrealizedPnl: "-33.95",
      realizedPnl: "0",
      pnl24h: "-2.23",
      pendingRedeemShares: "10",
      pendingDepositShares: "0",
      priced: true,
    },
  ],
  inFlight: {
    status: "ok",
    items: [
      {
        fundId: "FUND-B",
        name: "Sample Redeeming Fund",
        kind: "redeem",
        stage: null,
        direction: null,
        unit: "shares",
        amount: "10",
        count: 1,
      },
    ],
  },
  activity: {
    status: "ok",
    items: [
      {
        fundId: "FUND-B",
        name: "Sample Redeeming Fund",
        kind: "redeem",
        transactionType: "redeem",
        status: "processing",
        at: null,
        requestedAt: "2026-11-27T03:02:00.000Z",
        shares: "10",
        cost: null,
        proceeds: null,
      },
      {
        fundId: "FUND-A",
        name: "Sample Vault Fund",
        kind: "subscribe",
        transactionType: "recurring_buy",
        status: "failed",
        at: "2026-11-17T02:30:00.000Z",
        requestedAt: null,
        shares: null,
        cost: "25",
        proceeds: null,
      },
    ],
  },
});

const missing = (): Ok => ({
  status: "ok",
  readAt: "2026-11-28T03:00:00.000Z",
  summary: {
    currency: null,
    totalValue: null,
    settledValue: null,
    totalCost: null,
    totalPnl: null,
    totalRealizedPnl: null,
    totalUnrealizedPnl: null,
    totalPnl24h: null,
    inFlightValue: null,
    complete: null,
  },
  holdings: [
    {
      fundId: "FUND-C",
      name: null,
      fundType: null,
      shares: null,
      price: null,
      marketValue: null,
      avgCost: null,
      unrealizedPnl: null,
      realizedPnl: null,
      pnl24h: null,
      pendingRedeemShares: null,
      pendingDepositShares: null,
      priced: false,
    },
  ],
  inFlight: { status: "not_provided" },
  activity: { status: "not_provided" },
});

const empty = (): Ok => ({
  ...full(),
  summary: {
    ...full().summary,
    totalValue: "0",
    totalCost: "0",
    totalPnl: "0",
    inFlightValue: "0",
  },
  holdings: [],
  inFlight: { status: "ok", items: [] },
  activity: { status: "ok", items: [] },
});

function show() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <PortfolioPage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.usMarket = true;
  state.tab = "wealth";
  state.wealth = { kind: "pending" };
  state.calls = [];
});
afterEach(() => {
  cleanup();
});

describe("Portfolio › My Wealth (#592)", () => {
  it("switch off: no tabs, the Trading view stays even with ?tab=wealth, Wealth is never read", () => {
    state.usMarket = false;
    show();
    expect(screen.queryByRole("tablist", { name: "Portfolio views" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Portfolio" })).toBeInTheDocument();
    expect(state.calls).not.toContain("/api/v1/wealth/me");
  });

  it("tabs switch between Trading and My Wealth; Wealth is read only on its tab", async () => {
    state.tab = null;
    state.wealth = { kind: "ok", body: full() };
    show();
    const tabs = screen.getByRole("tablist", { name: "Portfolio views" });
    expect(within(tabs).getByRole("tab", { name: "Trading" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(state.calls).not.toContain("/api/v1/wealth/me");
    fireEvent.click(within(tabs).getByRole("tab", { name: "My Wealth" }));
    expect(await screen.findByRole("heading", { name: "Funds you hold" })).toBeInTheDocument();
    expect(state.calls).toContain("/api/v1/wealth/me");
  });

  it("renders totals, funds and activity from the API; read-only (no invest / redeem / move buttons)", async () => {
    state.wealth = { kind: "ok", body: full() };
    show();
    await screen.findByRole("region", { name: "Total value" });
    expect(screen.getByRole("heading", { name: "My Wealth" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "What you hold on SoDEX Wealth. Read from SoDEX for your wallet; no signature needed.",
      ),
    ).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Total value" })).getByText("$2,662.72"));
    expect(within(screen.getByRole("region", { name: "Total cost" })).getByText("$2,680.00"));
    const result = screen.getByRole("region", { name: "Total result" });
    expect(within(result).getByText("+$201.39")).toBeInTheDocument();
    expect(within(result).getByText("Realized +$218.67 · open −$17.28")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "24h" })).getByText("+$12.05"));
    const inFlight = screen.getByRole("region", { name: "Being processed" });
    expect(within(inFlight).getByText("$50.00")).toBeInTheDocument();
    expect(within(inFlight).getByText("1 request")).toBeInTheDocument();

    const funds = table("Funds you hold");
    expect(within(funds).getByText("Sample Vault Fund")).toBeInTheDocument();
    expect(within(funds).getByText("Vault · 10.00 shares redeeming")).toBeInTheDocument();
    expect(within(funds).getByText("−$33.95")).toBeInTheDocument();

    const activity = table("Activity");
    expect(within(activity).getByText("Redeem")).toBeInTheDocument();
    expect(within(activity).getByText("10.00 shares")).toBeInTheDocument();
    expect(within(activity).getByText("Processing")).toBeInTheDocument();
    expect(within(activity).getByText("Recurring buy")).toBeInTheDocument();
    expect(within(activity).getByText("$25.00")).toBeInTheDocument();
    expect(within(activity).getByText("Failed")).toBeInTheDocument();

    const can = screen.getByRole("region", { name: "What DeskLabs can do here" });
    expect(within(can).getByText("Invest, redeem or move funds")).toBeInTheDocument();
    expect(within(can).getByText("Never")).toBeInTheDocument();

    // Quy tắc 1: không có nút / link nạp, rút, chuyển.
    const actions = [...screen.queryAllByRole("button"), ...screen.queryAllByRole("link")].map(
      (el) => el.textContent ?? "",
    );
    for (const text of actions)
      expect(text).not.toMatch(/deposit|withdraw|transfer|invest|redeem|move/i);
  });

  it("missing fields show Not provided, never 0", async () => {
    state.wealth = { kind: "ok", body: missing() };
    show();
    const total = await screen.findByRole("region", { name: "Total value" });
    expect(within(total).getByText("Not provided")).toBeInTheDocument();
    for (const label of ["Total cost", "Total result", "24h", "Being processed"]) {
      const tile = screen.getByRole("region", { name: label });
      expect(within(tile).getByText("Not provided")).toBeInTheDocument();
      expect(tile.textContent).not.toMatch(/\$0|(^|\D)0(\.0+)?(\D|$)/);
    }
    const funds = table("Funds you hold");
    // Tên thiếu → mã quỹ SoDEX trả; 6 ô số → "Not provided".
    expect(within(funds).getByText("FUND-C")).toBeInTheDocument();
    expect(within(funds).getAllByText("Not provided")).toHaveLength(6);
    expect(within(funds).queryByText(/\$0/)).toBeNull();
    const activity = screen.getByRole("region", { name: "Activity" });
    expect(within(activity).getByText("Not provided")).toBeInTheDocument();
  });

  it("not connected: invites to connect SoDEX", async () => {
    state.wealth = { kind: "ok", body: { status: "not_connected" } };
    show();
    expect(
      await screen.findByText("Connect your SoDEX account to see what you hold on SoDEX Wealth."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Total value" })).toBeNull();
  });

  it("nothing on Wealth: empty state instead of zero tiles", async () => {
    state.wealth = { kind: "ok", body: empty() };
    show();
    expect(
      await screen.findByRole("heading", { name: "Nothing on SoDEX Wealth yet" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Total value" })).toBeNull();
    expect(screen.queryByText("$0.00")).toBeNull();
    expect(screen.getByRole("region", { name: "What DeskLabs can do here" })).toBeInTheDocument();
  });

  it("own weight budget (429 sodex_wealth_budget): busy message, not Not provided", async () => {
    state.wealth = {
      kind: "error",
      error: new ApiError("RATE_LIMITED", 429, {
        reason: "sodex_wealth_budget",
        retryAfterMs: 20_000,
      }),
    };
    show();
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("SoDEX Wealth is busy. Try again in a minute.")).toBeVisible();
    expect(screen.queryByText("Not provided")).toBeNull();
  });

  it("has no axe violations", async () => {
    state.wealth = { kind: "ok", body: full() };
    show();
    await screen.findByRole("heading", { name: "Funds you hold" });
    // landmark-unique: DataTable dùng chung (packages/ui) đặt cùng tên cho khung và vùng cuộn, như mọi bảng Portfolio.
    const r = await axe.run(document.body, {
      rules: { region: { enabled: false }, "landmark-unique": { enabled: false } },
    });
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });
});
