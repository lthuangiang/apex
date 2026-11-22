// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";

import { ApiError } from "@/lib/api";

import messages from "../../../../messages/en.json";
import { BotActions } from "../components/bot-actions";
import { useBotErrorText } from "../components/bot-errors";

// #471: bot news (`news_signal`) còn lệnh mở thì không archive được. Danh sách bot khoá nút Archive kèm câu giải thích (PM
// duyệt); API vẫn trả 409 `open_trades` (ví dụ còn lệnh SoDEX mở) thì hiện đúng câu đó, không hiện lỗi chung.

const SENTENCE = "This bot still has open trades. Close them first, then archive.";
const BOT_ID = "11111111-1111-4111-8111-111111111111";
const state = vi.hoisted((): { trades: unknown[]; archive: "ok" | "open_trades" } => ({
  trades: [],
  archive: "ok",
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => undefined, push: () => undefined }),
}));
vi.mock("@/lib/queries", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSodexConnection: () => ({ data: undefined, isSuccess: false }),
}));
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...real,
    api: (method: string, path: string, schema: z.ZodType) => {
      const p = new URL(path, "http://x").pathname;
      if (p.endsWith("/trades")) return Promise.resolve(schema.parse({ items: state.trades }));
      if (method === "POST" && p.endsWith("/actions/archive")) {
        if (state.archive === "open_trades")
          return Promise.reject(
            new real.ApiError("STATE_CONFLICT", 409, { reason: "open_trades" }),
          );
        return new Promise(() => undefined);
      }
      return Promise.reject(new real.ApiError("NOT_FOUND", 404));
    },
  };
});

const NOW = "2026-11-22T10:00:00.000Z";
const trade = (status: "open" | "closed") => ({
  id:
    status === "open"
      ? "22222222-2222-4222-8222-222222222222"
      : "22222222-2222-4222-8222-222222222223",
  signalId: "33333333-3333-4333-8333-333333333333",
  market: "SOL-USD",
  side: "short",
  status,
  sizeUsdc: "100",
  qty: "0.47",
  entryAvgPrice: "212.4",
  tpPrice: "205.1",
  slPrice: "216.05",
  maxHoldUntil: NOW,
  openedAt: NOW,
  closedAt: status === "closed" ? NOW : null,
  closeReason: status === "closed" ? "TAKE_PROFIT" : null,
  exitAvgPrice: null,
  pendingCommand: null,
  leverage: 5,
});

const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <main>{ui}</main>
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );

const row = (strategy: "news_signal" | "futures_grid" = "news_signal") => (
  <BotActions
    bot={{ id: BOT_ID, name: "Stock Monitor", state: "stopped", reasonCode: null, strategy }}
  />
);
const archiveBtn = () => screen.getByRole("button", { name: /Archive/ });

beforeEach(() => {
  state.trades = [];
  state.archive = "ok";
});
afterEach(() => {
  cleanup();
});

describe("archive a news bot with open trades (#471)", () => {
  it("locks Archive and says why while a trade is open", async () => {
    state.trades = [trade("open"), trade("closed")];
    wrap(row());
    expect(await screen.findByText(SENTENCE, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(archiveBtn()).toBeDisabled();
    expect(archiveBtn()).toHaveAccessibleDescription(SENTENCE);
    const r = await axe.run(document.body, { rules: { "color-contrast": { enabled: false } } });
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });

  it("all trades closed: Archive works as before", async () => {
    state.trades = [trade("closed")];
    wrap(row());
    await waitFor(() => {
      expect(archiveBtn()).toBeEnabled();
    });
    expect(screen.queryByText(SENTENCE)).toBeNull();
  });

  it("other strategies never ask for news trades and keep Archive", () => {
    state.trades = [trade("open")];
    wrap(row("futures_grid"));
    expect(archiveBtn()).toBeEnabled();
    expect(screen.queryByText(SENTENCE)).toBeNull();
  });

  it("a 409 open_trades from the API shows the sentence, not the generic error", async () => {
    state.archive = "open_trades";
    wrap(row());
    await waitFor(() => {
      expect(archiveBtn()).toBeEnabled();
    });
    await userEvent.click(archiveBtn());
    expect(await screen.findByRole("alert")).toHaveTextContent(SENTENCE);
  });

  it("maps STATE_CONFLICT open_trades to the sentence", () => {
    const { result } = renderHook(() => useBotErrorText(), {
      wrapper: ({ children }) => (
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          {children}
        </NextIntlClientProvider>
      ),
    });
    expect(result.current(new ApiError("STATE_CONFLICT", 409, { reason: "open_trades" }))).toBe(
      SENTENCE,
    );
  });
});
