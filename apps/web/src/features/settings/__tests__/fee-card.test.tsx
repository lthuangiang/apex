// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { MmFee } from "@drift/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { SodexAccessTab } from "../components/sodex-access-tab";

// Settings › SoDEX access, thẻ DeskLabs builder fee (ST-02; docs/mockups/mm-fee-tiers 5a, 5b): mức approve tách khỏi
// mức từng chiến lược trả, dòng Market Making theo `mmFee`, bảng bậc luôn hiện.

const AXE = {
  runOnly: {
    type: "tag" as const,
    values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
  },
};

const feat = vi.hoisted<{ mmFee: MmFee | null; builderFees: Record<string, number> }>(() => ({
  mmFee: null,
  builderFees: {},
}));
vi.mock("@/lib/queries", () => ({
  useSodexConnection: () => ({
    isPending: false,
    isError: false,
    data: {
      connection: {
        address: "0x1111111111111111111111111111111111111111",
        sodexAccountId: "42",
        status: "connected",
        apiKey: null,
        builderFee: {
          builderId: "1645",
          spot: 10,
          perps: 10,
          approved: true,
          exempt: false,
          readBackAt: "2026-11-16T00:00:00.000Z",
        },
      },
    },
  }),
  useTwoFactorNeeded: () => false,
  useFeatures: () => ({
    data: {
      volumeMaker: true,
      volumeFarm: true,
      aiDesk: false,
      adaptiveDca: false,
      builderFees: feat.builderFees,
      mmFee: feat.mmFee,
    },
  }),
}));
vi.mock("../components/master-wallet", () => ({
  useMasterWallet: () => ({ ensure: () => Promise.resolve(), prompt: null }),
}));
vi.mock("@/lib/use-sodex-signature", () => ({ useSodexSignature: () => () => undefined }));
vi.mock("@/lib/api", () => ({
  ApiError: class extends Error {},
  api: () => new Promise(() => undefined),
}));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const show = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <main>
          <SodexAccessTab />
        </main>
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );

const mmRow = () => screen.getByText("Market Making · your rate").nextElementSibling;

afterEach(() => {
  feat.mmFee = null;
  feat.builderFees = {};
  cleanup();
});

describe("Settings › DeskLabs builder fee", () => {
  it("replaces the one-rate sentence and puts the revoke note next to the button", async () => {
    show();
    expect(screen.queryByText(/DeskLabs offers one rate/)).not.toBeInTheDocument();
    expect(
      screen.getByText("You approve up to 0.01%. Each strategy charges its own rate, never more."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "You can approve 0.01% or set it to 0. Setting it to 0 pauses all your bots.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revoke (set to 0)" })).toBeInTheDocument();
    const r = await axe.run(document.body, AXE);
    expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  it("mmFee null: default Market Making rate, the tier sentence and the ladder; Volume Builder and the rest", () => {
    show();
    expect(mmRow()).toHaveTextContent("0.003%");
    expect(
      screen.getByText(
        "The rate drops to 0.002% at $200K and 0.001% at $1M of Market Making volume in 30 days; running bots switch on their next orders.",
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(4);
    expect(screen.getByText("Volume Builder").nextElementSibling).toHaveTextContent(/^0\.005%$/);
    expect(screen.getByText("Every other strategy").nextElementSibling).toHaveTextContent(
      /^0\.01%$/,
    );
    expect(screen.queryByText("Set for your account")).not.toBeInTheDocument();
  });

  it("tier with a next tier: volume and the amount left, You on the current row", async () => {
    feat.mmFee = {
      rate: 3,
      source: "tier",
      volume30d: "142300",
      nextVolume: "200000",
      nextRate: 2,
    };
    show();
    expect(
      screen.getByText(
        /^\$142,300 Market Making volume, last 30 days\. .*new orders pay 0\.002%\.$/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("$57,700 more")).toBeInTheDocument();
    expect(screen.getByText("You").closest("tr")).toHaveTextContent("Under $200K");
    const r = await axe.run(document.body, AXE);
    expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  it("top tier: Lowest rate and the keep-tier sentence", () => {
    feat.mmFee = {
      rate: 1,
      source: "tier",
      volume30d: "1240000",
      nextVolume: null,
      nextRate: null,
    };
    show();
    expect(mmRow()).toHaveTextContent("0.001%Lowest rate");
    expect(
      screen.getByText(
        "$1,240,000 Market Making volume in the last 30 days. Stay above $1M to keep this rate.",
      ),
    ).toBeInTheDocument();
  });

  it("custom rates: the custom sentence for Market Making and Set for your account on other rows", () => {
    feat.mmFee = { rate: 2, source: "custom", volume30d: null, nextVolume: null, nextRate: null };
    feat.builderFees = { volume_maker: 2, volume_farm: 4, spot_grid: 10 };
    show();
    expect(mmRow()).toHaveTextContent("0.002%");
    expect(
      screen.getByText(
        "Set for your account by DeskLabs. Volume tiers don’t apply while this rate is set.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("You")).not.toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(4);
    expect(screen.getByText("Volume Builder").nextElementSibling).toHaveTextContent(
      "Set for your account0.004%",
    );
    expect(screen.getByText("Every other strategy").nextElementSibling).toHaveTextContent(
      /^0\.01%$/,
    );
  });
});
