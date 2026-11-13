// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { isPicked, MarketsCard, WhatYoullCopy, type MarketsPick } from "../components/copy-markets";

// Chọn market và đòn bẩy theo market (artboard CopyMarkets, DEC-226): tick / bỏ tick, cảnh báo copy
// một phần, lỗi khi bỏ hết, per-market mở nút −/+ trong trần, số thiếu → "Not available", axe 0.

vi.mock("@/components/workspace", () => ({
  Card: ({ title, children }: { title: string; children: ReactNode }) => (
    <section aria-label={title}>
      <h2>{title}</h2>
      {children}
    </section>
  ),
}));

const ROWS = [
  {
    market: "NEAR-USD",
    selected: true,
    leverage: 2,
    maxLeverage: 5,
    marginPerPosition: "125",
    liquidationPct: "48.5",
    trades30d: 12,
  },
  {
    market: "FIL-USD",
    selected: true,
    leverage: 1,
    maxLeverage: 1,
    marginPerPosition: "250",
    liquidationPct: null,
    trades30d: null,
  },
];

function Harness() {
  const [pick, setPick] = useState<MarketsPick>({ picked: null, perMarket: false, levs: {} });
  const all = ROWS.map((r) => r.market);
  const levOf = (r: (typeof ROWS)[number]) =>
    pick.perMarket
      ? Math.min(Math.max(1, pick.levs[r.market] ?? r.leverage), r.maxLeverage)
      : r.leverage;
  const picked = ROWS.filter((r) => isPicked(pick, r.market));
  return (
    <>
      <MarketsCard
        rows={ROWS.map((r) => ({ ...r, leverage: levOf(r) }))}
        loading={false}
        pick={pick}
        presetName="Balanced"
        presetLeverage={2}
        perTrade="250"
        cap="500"
        onToggle={(m) => {
          setPick((cur) => {
            const now = cur.picked ?? all;
            const next = now.includes(m) ? now.filter((x) => x !== m) : [...now, m];
            return { ...cur, picked: next.length === all.length ? null : next };
          });
        }}
        onSelectAll={() => {
          setPick((cur) => ({ ...cur, picked: null }));
        }}
        onPerMarket={(on) => {
          setPick((cur) => ({
            ...cur,
            perMarket: on,
            levs: on ? Object.fromEntries(ROWS.map((r) => [r.market, r.leverage])) : {},
          }));
        }}
        onLeverage={(m, lev) => {
          setPick((cur) => ({ ...cur, levs: { ...cur.levs, [m]: lev } }));
        }}
      />
      <WhatYoullCopy picked={picked.length} total={ROWS.length} levs={picked.map(levOf)} />
    </>
  );
}

const show = () =>
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <Harness />
    </NextIntlClientProvider>,
  );

afterEach(cleanup);

describe("Markets we'll copy", () => {
  it("shows every market ticked, the per-market numbers, and Not available instead of 0", async () => {
    const { container } = show();
    expect(
      screen.getByRole("heading", { name: "Markets we'll copy · 2 of 2" }),
    ).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Markets" });
    const near = within(table).getByRole("row", { name: /NEAR-USD/ });
    expect(within(near).getByText("12 trades")).toBeInTheDocument();
    expect(within(near).getByText("≈ 48.5%")).toBeInTheDocument();
    const fil = within(table).getByRole("row", { name: /FIL-USD/ });
    expect(within(fil).getAllByText("Not available")).toHaveLength(2);
    expect(
      screen.getByText("2× from Balanced for every market (lower where SoDEX allows less)."),
    ).toBeInTheDocument();
    expect(screen.getByText(/All positions together still stay under \$500\./)).toBeInTheDocument();
    // Không per-market: không có nút −/+.
    expect(screen.queryByRole("button", { name: "Raise leverage for NEAR-USD" })).toBeNull();
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it("warns when copying part of the trades, and asks for at least one market when none is left", async () => {
    const { container } = show();
    const table = screen.getByRole("table", { name: "Markets" });
    fireEvent.click(within(table).getByRole("checkbox", { name: "Copy FIL-USD" }));
    expect(
      screen.getByRole("heading", { name: "Markets we'll copy · 1 of 2" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "You're copying part of this trader's trades.",
    );
    expect(within(table).getByRole("row", { name: /FIL-USD/ })).toHaveTextContent("Not copied");
    fireEvent.click(within(table).getByRole("checkbox", { name: "Copy NEAR-USD" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Pick at least one market.");
    expect((await axe.run(container)).violations).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(
      screen.getByRole("heading", { name: "Markets we'll copy · 2 of 2" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("sets leverage per market within the cap and sums it up on the side", async () => {
    const { container } = show();
    const [perToggle] = screen.getAllByRole("checkbox", {
      name: /Set per market|Set leverage per market/,
    });
    if (perToggle === undefined) throw new Error("no per-market toggle");
    fireEvent.click(perToggle);
    expect(
      screen.getByText("Set for each market below, up to what SoDEX allows."),
    ).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Markets" });
    const raise = within(table).getByRole("button", { name: "Raise leverage for NEAR-USD" });
    fireEvent.click(raise);
    fireEvent.click(raise);
    fireEvent.click(raise);
    // Trần 5×: nút + khoá ở 5.
    expect(within(table).getByRole("row", { name: /NEAR-USD/ })).toHaveTextContent("5×");
    expect(raise).toBeDisabled();
    // FIL chỉ cho 1×: cả −, + đều khoá.
    expect(
      within(table).getByRole("button", { name: "Raise leverage for FIL-USD" }),
    ).toBeDisabled();
    expect(
      within(table).getByRole("button", { name: "Lower leverage for FIL-USD" }),
    ).toBeDisabled();
    const side = screen.getByRole("region", { name: "What you'll copy" });
    expect(side).toHaveTextContent("2 of 2");
    expect(side).toHaveTextContent("1–5×");
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
