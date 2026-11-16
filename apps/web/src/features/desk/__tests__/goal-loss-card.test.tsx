// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { GoalLossCard } from "../components/needs-you-card";

// RS-01 (DEC-272): việc cấp account không có bot: không link sửa bot, không Later, không so sánh.

vi.mock("@/lib/api", () => ({ api: () => new Promise(() => undefined) }));

afterEach(() => {
  cleanup();
});

const item = (facts: { name: string; value: string }[]) => ({
  id: "5f1d2c3b-0000-5000-8000-000000000001",
  botId: null,
  botName: "",
  strategy: "",
  market: "",
  rule: "goal_loss_over" as const,
  severity: 3,
  whatif: null,
  facts: facts.map((f) => ({ id: f.name, ...f, unit: "usdc" as const, source: "risk" as const })),
});

const show = (i: ReturnType<typeof item>) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <GoalLossCard item={i} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );

describe("goal loss Needs you card (RS-01)", () => {
  it("names the loss against the goal's limit and offers Review your bots and Change goal only", () => {
    show(
      item([
        { name: "goal_used", value: "600" },
        { name: "goal_limit", value: "500" },
      ]),
    );
    expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent(
      /Losses passed your goal’s limit: .*600.* of .*500.* USDC\./,
    );
    expect(screen.getByRole("link", { name: "Review your bots" })).toHaveAttribute("href", "/bots");
    expect(screen.getByRole("link", { name: "Change goal" })).toHaveAttribute(
      "href",
      "/onboarding/goals?from=desk",
    );
    expect(screen.queryByRole("button", { name: /Later/ })).toBeNull();
    expect(document.querySelector('a[href*="/edit"]')).toBeNull();
  });

  it("shows nothing without both numbers", () => {
    const { container } = show(item([{ name: "goal_used", value: "600" }]));
    expect(container).toBeEmptyDOMElement();
  });
});
