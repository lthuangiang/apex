/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { HowItWorksDrawer } from "../research/how-it-works";

// #391: số trong tab Overview không viết cứng. Đổi hằng của @drift/shared thì câu đổi theo.

vi.mock("@drift/shared", async (importOriginal) => {
  const real = await importOriginal<typeof import("@drift/shared")>();
  return {
    ...real,
    NEWS_CYCLE_MINUTES: 10,
    GATE_MIN_CLOSED: 150,
    CLASSIFIER_GATE: { minLabels: 70, minPrecisionPct: 85 },
    NEWS_CLASSIFIER: { ...real.NEWS_CLASSIFIER, maxContentChars: 6000 },
    MARKET_STATE_RULES: { ...real.MARKET_STATE_RULES, btcHours: 12, volHours: 6 },
    NEWS_RULES: {
      ...real.NEWS_RULES,
      maxArticleAgeHours: 48,
      maxSourceDelayMinutes: 20,
      maxEventAgeHours: 36,
      storyWindowDays: 9,
      minTpCostMultiple: "3",
    },
  };
});

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return { ...real, api: () => Promise.reject(new real.ApiError("NOT_FOUND", 404)) };
});

describe("How it works › Overview numbers", { timeout: 30_000 }, () => {
  it("follow the shared constants", async () => {
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <HowItWorksDrawer
            tab="overview"
            onTab={() => undefined}
            onClose={() => undefined}
            version={null}
            rulesVersion={3}
          />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
    const dlg = await screen.findByRole("dialog", { name: "How it works" });
    const panel = within(dlg).getByRole("tabpanel");
    expect(panel).toHaveTextContent(/^Every 10 minutes DeskLabs reads new crypto news/);
    expect(panel).toHaveTextContent("in the same 10-minute run");
    expect(panel).toHaveTextContent("Published over 48 h ago");
    expect(panel).toHaveTextContent("Over 20 min since it was published");
    expect(panel).toHaveTextContent("the first 6,000 characters");
    expect(panel).toHaveTextContent("the event is not over 36 h old");
    expect(panel).toHaveTextContent("70 random labels, at least 85% marked right");
    const img = within(dlg).getByRole("img");
    expect(img).toHaveTextContent("every 10 min");
    expect(img).toHaveTextContent("only if under 20 min old");
    expect(img).toHaveTextContent("150 closed trades,");
    await userEvent.click(within(dlg).getByText("Filter", { selector: "summary span" }));
    expect(panel).toHaveTextContent("per 9 days");
    expect(panel).toHaveTextContent("TP at least 3× the cost of a trade");
    await userEvent.click(within(dlg).getByText("Context", { selector: "summary span" }));
    expect(panel).toHaveTextContent("BTC trend over 12 h, volatility over 6 h");
    // Results (chặng cuối, lùi một bước từ chặng đầu): số lệnh cần.
    await userEvent.click(within(dlg).getByRole("button", { name: "Previous step" }));
    expect(within(dlg).getByTestId("hiw-caption")).toHaveTextContent(
      "counts toward the 150 trades a news type needs",
    );
  });
});
