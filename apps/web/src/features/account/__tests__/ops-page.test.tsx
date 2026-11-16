// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { OpsPage } from "../components/ops-page";

// Trang Ops (DEC-276): đang tải, rỗng, lỗi, dữ liệu cũ khi làm mới lỗi, 403. Số thiếu → "Not available".

const mode = vi.hoisted(() => ({ value: "ok" }));
vi.mock("@/components/workspace", () => ({
  Workspace: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  PageHead: ({ title, action }: { title: string; action?: ReactNode }) => (
    <header>
      <h1>{title}</h1>
      {action}
    </header>
  ),
  Card: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));
vi.mock("@/features/bots", () => ({
  useStateLabel: () => (b: { state: string }) => ({ state: b.state, label: b.state }),
}));
vi.mock("@/lib/markets", () => ({
  useMarketNames: () => Object.assign((m: string) => m, { market: (m: string) => m }),
}));
vi.mock("@/lib/use-media", () => ({ BELOW_LG: "", useMediaQuery: () => false }));
vi.mock("@/lib/api", () => {
  class ApiError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  }
  return {
    ApiError,
    api: () => {
      if (mode.value === "forbidden") return Promise.reject(new ApiError("FORBIDDEN"));
      if (mode.value === "error") return Promise.reject(new ApiError("INTERNAL"));
      return Promise.resolve({
        checkedAt: "2026-11-16T10:00:00.000Z",
        bots: mode.value === "empty" ? [] : [bot],
      });
    },
  };
});

const bot = {
  botId: "01a1d823-0000-7000-8000-00000000d50d",
  userId: "01a1d823-0000-7000-8000-0000000000aa",
  name: "BTC Market Making",
  strategy: "volume_maker",
  market: "BTC-USD",
  state: "running",
  costPerMillion: "141.2",
  volumeHour: null,
  requestsPerMinute: "39.3",
  makerSharePct: null,
  untrackedCancels: 0,
  positionCuts: 1,
  maxQuoteGapSec: "3.0",
  latestInvariant: null,
};

const show = (client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) =>
  render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <OpsPage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );

// jsdom không tính được màu thật: tắt color-contrast như các test axe khác (mm-cost.test.tsx).
const AXE = {
  runOnly: {
    type: "tag" as const,
    values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
  },
  rules: { "color-contrast": { enabled: false } },
};

afterEach(() => {
  mode.value = "ok";
  cleanup();
});

describe("team Ops page", () => {
  it("shows each bot with Not available for missing numbers, never 0, and links to the owner", async () => {
    show();
    const link = await screen.findByRole("link", { name: "BTC Market Making" });
    expect(link).toHaveAttribute("href", `/admin/users/${bot.userId}`);
    expect(screen.getAllByText("Not available").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("39.3")).toBeInTheDocument();
    expect(screen.getByText("None")).toBeInTheDocument();
    expect(screen.queryByText(/catalog\./)).toBeNull();
  });

  it("has no accessibility violations (WCAG 2.2 AA)", async () => {
    show();
    await screen.findByRole("link", { name: "BTC Market Making" });
    const r = await axe.run(document.body, AXE);
    expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  }, 15_000);

  it("says so when no bot ran in the last 24 hours", async () => {
    mode.value = "empty";
    show();
    expect(
      await screen.findByText("No Market Making or Volume Farm bots ran in the last 24 hours."),
    ).toBeInTheDocument();
  });

  it("shows its own error title when the first load fails", { timeout: 15_000 }, async () => {
    mode.value = "error";
    show();
    // Trang tự thử lại 2 lần (trừ 403) trước khi báo lỗi.
    expect(
      await screen.findByText("Couldn’t load Ops. Try Refresh.", undefined, { timeout: 10_000 }),
    ).toBeInTheDocument();
  });

  it(
    "keeps the last data and marks it stale when a refresh fails",
    { timeout: 15_000 },
    async () => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      client.setQueryData(["team-ops"], { checkedAt: "2026-11-16T09:59:00.000Z", bots: [bot] });
      mode.value = "error";
      show(client);
      expect(
        await screen.findByText("Couldn’t refresh. Showing the last data that loaded.", undefined, {
          timeout: 10_000,
        }),
      ).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "BTC Market Making" })).toBeInTheDocument();
    },
  );

  it("tells non-team users the page is for the team and offers no refresh", async () => {
    mode.value = "forbidden";
    show();
    expect(await screen.findByText("Ops is for the DeskLabs team only.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
  });
});
