// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { chipNames } from "../components/desk-page";
import { GoalCard } from "../components/goal-card";

// Trang chủ AI Desk (artboard BP-Home): thẻ Mục tiêu báo rõ khi lỗ đã vượt giới hạn; chip bot trùng tên phân biệt được.

vi.mock("@/lib/api", () => ({ api: () => new Promise(() => undefined) }));

const show = (used: string | null) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <GoalCard goal={{ goal: "automate", limit: "10", used }} items={[]} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );

afterEach(() => {
  cleanup();
});

describe("Goal card", () => {
  it("fills the bar in the normal colour inside the limit", () => {
    show("4");
    expect(screen.getByText("4 of 10 USDC")).toBeInTheDocument();
    expect(screen.queryByText(/Over your limit/)).not.toBeInTheDocument();
    expect(screen.getByRole("meter").firstElementChild).toHaveClass("bg-accent");
  });

  it("says the loss is over the limit and turns the bar red", () => {
    show("33.33");
    expect(screen.getByText("Over your limit · 33.33 of 10 USDC")).toBeInTheDocument();
    expect(screen.getByRole("meter").firstElementChild).toHaveClass("bg-neg");
  });

  it("shows Not available, never 0, without a snapshot", () => {
    show(null);
    expect(screen.getByText("Not available")).toBeInTheDocument();
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
  });
});

describe("bot chip names", () => {
  it("adds the market, then the last 4 of the id, only when names repeat", () => {
    const names = chipNames([
      {
        botId: "00000000-0000-0000-0000-00000000aaaa",
        name: "INTC Futures DCA",
        market: "INTC-USD",
      },
      {
        botId: "00000000-0000-0000-0000-00000000bbbb",
        name: "INTC Futures DCA",
        market: "INTC-USD",
      },
      { botId: "00000000-0000-0000-0000-00000000cccc", name: "BTC Grid", market: "BTC-USD" },
      { botId: "00000000-0000-0000-0000-00000000dddd", name: "ETH DCA", market: "ETH-USD" },
      { botId: "00000000-0000-0000-0000-00000000eeee", name: "ETH DCA", market: "ETH-PERP" },
    ]);
    expect(names.get("00000000-0000-0000-0000-00000000aaaa")).toBe("INTC Futures DCA ··aaaa");
    expect(names.get("00000000-0000-0000-0000-00000000bbbb")).toBe("INTC Futures DCA ··bbbb");
    expect(names.get("00000000-0000-0000-0000-00000000cccc")).toBe("BTC Grid");
    expect(names.get("00000000-0000-0000-0000-00000000dddd")).toBe("ETH DCA · ETH-USD");
  });
});
