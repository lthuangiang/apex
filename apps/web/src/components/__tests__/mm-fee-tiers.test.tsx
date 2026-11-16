// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { builderFeeRateOf, FEE_TIERS, type MmFee } from "@drift/shared";
import { cleanup, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it } from "vitest";

import messages from "../../../messages/en.json";
import { feeLabels } from "../../lib/format";
import { MmFeeCatalog, mmFeeView, mmTierRows } from "../mm-fee-tiers";

// Thẻ phí Market Making theo bậc volume (docs/mockups/mm-fee-tiers 2b, 2c): mỗi trạng thái của `mmFee`,
// bảng 3 bậc luôn hiện, không bao giờ hiện $0 khi thiếu dữ liệu (quy tắc 1.8).

const AXE = {
  runOnly: {
    type: "tag" as const,
    values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
  },
};

const mm = (over: Partial<MmFee>): MmFee => ({
  rate: 3,
  source: "default",
  volume30d: null,
  nextVolume: "200000",
  nextRate: 2,
  ...over,
});

const show = (mmFee: MmFee | null, fallback = 3) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <main>
        <MmFeeCatalog view={mmFeeView(mmFee, fallback)} />
      </main>
    </NextIntlClientProvider>,
  );

const ladder = () => {
  const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
  return rows.map((r) => r.textContent);
};

afterEach(cleanup);

describe("Market Making fee tiers", () => {
  it("builds the ladder from FEE_TIERS and builderFeeRateOf, not hard-coded numbers", () => {
    const rows = mmTierRows();
    expect(rows[0]?.rate).toBe(builderFeeRateOf("volume_maker"));
    expect(rows.slice(1).map((r) => r.rate)).toEqual(
      [...(FEE_TIERS.volume_maker ?? [])]
        .sort((a, b) => a.minVolume - b.minVolume)
        .map((t) => t.rate),
    );
  });

  it("signed out (mmFee null): the plain rate and the ladder, no marker, no progress", async () => {
    show(null);
    expect(screen.getByText("Builder fee 0.003%")).toBeInTheDocument();
    expect(ladder()).toEqual(["Under $200K0.003%", "$200K to $1M0.002%", "$1M and up0.001%"]);
    expect(screen.queryByText("You")).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText(/^Checked every hour from your real-money/)).toBeInTheDocument();
    const r = await axe.run(document.body, AXE);
    expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  it("source default with volume: like 2a, no progress bar and never $0", async () => {
    show(mm({ source: "default", volume30d: "0" }));
    expect(screen.getByText("Builder fee 0.003%")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByText(/\$0\b/)).not.toBeInTheDocument();
    expect(screen.queryByText("You")).not.toBeInTheDocument();
    const r = await axe.run(document.body, AXE);
    expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  it("volume30d null even with a tier: like 2a", () => {
    show(mm({ source: "tier", rate: 2, volume30d: null, nextVolume: "1000000", nextRate: 1 }));
    expect(screen.getByText("Builder fee 0.002%")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("tier with a next tier: progress bar, the amount left (Decimal subtraction) and the You row", async () => {
    show(
      mm({ source: "tier", rate: 2, volume30d: "342300.4", nextVolume: "1000000", nextRate: 1 }),
    );
    expect(screen.getByText("Your builder fee")).toBeInTheDocument();
    const bar = screen.getByRole("img", { name: "$342,300 of $1,000,000" });
    expect(bar.firstElementChild).toHaveStyle({ width: "34.23004%" });
    expect(screen.getByText("$342,300 Market Making volume, last 30 days")).toBeInTheDocument();
    expect(screen.getByText("$1M")).toBeInTheDocument();
    // 1,000,000 − 342,300.4 = 657,699.6 → làm tròn lên $657,700.
    expect(screen.getByText("$657,700 more")).toBeInTheDocument();
    expect(screen.getByText(/in 30 days and new orders pay 0\.001%\./)).toBeInTheDocument();
    const here = screen
      .getAllByRole("row")
      .filter((r) => r.getAttribute("aria-current") === "true");
    expect(here.map((r) => r.textContent)).toEqual(["$200K to $1MYou0.002%"]);
    const r = await axe.run(document.body, AXE);
    expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  it("tier already past the threshold before the hourly job: no negative or $0 amount", () => {
    show(mm({ source: "tier", rate: 2, volume30d: "1000500", nextVolume: "1000000", nextRate: 1 }));
    expect(screen.queryByText(/more$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\$0\b/)).not.toBeInTheDocument();
  });

  it("top tier: Lowest rate pill and the keep-tier sentence", async () => {
    show(mm({ source: "tier", rate: 1, volume30d: "1240000", nextVolume: null, nextRate: null }));
    expect(screen.getByText("Lowest rate")).toBeInTheDocument();
    expect(
      screen.getByText(
        "$1,240,000 Market Making volume in the last 30 days. Stay above $1M to keep this rate.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    const here = screen
      .getAllByRole("row")
      .filter((r) => r.getAttribute("aria-current") === "true");
    expect(here.map((r) => r.textContent)).toEqual(["$1M and upYou0.001%"]);
    const r = await axe.run(document.body, AXE);
    expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  it("custom (team-set, DEC-159): the custom sentence and the ladder without a You row", async () => {
    show(mm({ source: "custom", rate: 10, volume30d: "5000", nextVolume: null, nextRate: null }));
    expect(screen.getByText("Your builder fee")).toBeInTheDocument();
    expect(screen.getByText(feeLabels(10).pct)).toBeInTheDocument();
    expect(
      screen.getByText(
        "Set for your account by DeskLabs. Volume tiers don’t apply while this rate is set.",
      ),
    ).toBeInTheDocument();
    expect(ladder()).toHaveLength(3);
    expect(screen.queryByText("You")).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    const r = await axe.run(document.body, AXE);
    expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});
