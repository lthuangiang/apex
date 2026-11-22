// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { baselineVersionConfig, type BotSummary } from "@drift/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";

import messages from "../../../../messages/en.json";
import { BotEdit } from "../../bots/components/bot-edit";
import { NewsConfigBody, NewsStopBlock } from "../mainnet/agent-news";
import { linkTarget, signalResearchBotHref } from "../research/mode-memory";

// #470: Trading Agent với bot `news_signal`: Configuration dùng lại Settings chỉ xem (#469), link "Open in Signal
// Research" thay "Edit bot", `/bots/:id/edit` chuyển sang Signal Research, Stop dùng hộp Keep / Close all của bot news.

const BOT_ID = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-11-22T10:00:00.000Z";
const M = messages.signalAnalysis.research.mainnet;
const replace = vi.hoisted(() => vi.fn());

const state = vi.hoisted(
  (): { calls: { method: string; path: string; body: unknown }[]; config: unknown } => ({
    calls: [],
    config: null,
  }),
);

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, replace }),
}));
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...real,
    api: (method: string, path: string, schema: z.ZodType, opts?: { body?: unknown }) => {
      state.calls.push({ method, path, body: opts?.body });
      const p = new URL(path, "http://x").pathname;
      if (p === `/api/v1/bots/${BOT_ID}`)
        return Promise.resolve(
          schema.parse({
            bot: bot(),
            versions: [
              {
                id: "44444444-4444-4444-8444-444444444444",
                version: 1,
                config: state.config,
                paramSource: "manual",
                status: "active",
                appliedAt: NOW,
                createdAt: NOW,
              },
            ],
            events: [],
            openOrders: 0,
            serverTime: NOW,
            recentErrors: [],
          }),
        );
      if (p.endsWith("/trades"))
        return Promise.resolve(
          schema.parse({
            items: [
              {
                id: "22222222-2222-4222-8222-222222222222",
                signalId: "33333333-3333-4333-8333-333333333333",
                market: "SOL-USD",
                side: "short",
                status: "open",
                sizeUsdc: "100",
                qty: "0.47",
                entryAvgPrice: "212.4",
                tpPrice: "205.1",
                slPrice: "216.05",
                maxHoldUntil: NOW,
                openedAt: NOW,
                closedAt: null,
                closeReason: null,
                exitAvgPrice: null,
                pendingCommand: null,
              },
            ],
          }),
        );
      if (method === "POST" && p.endsWith("/actions/stop"))
        return Promise.resolve(schema.parse({ ...bot(), state: "stopping" }));
      return Promise.reject(new real.ApiError("NOT_FOUND", 404));
    },
  };
});
vi.mock("@/lib/queries", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSodexConnection: () => ({
    isSuccess: true,
    data: { connection: { status: "connected", apiKey: { last4: "4f2a" } } },
  }),
  useMe: () => ({ data: { role: "user", timezone: "UTC" } }),
}));

function bot(): BotSummary {
  return {
    id: BOT_ID,
    name: "Stock Monitor",
    strategy: "news_signal",
    market: "",
    engine: "perps",
    state: "running",
    reasonCode: null,
    needsAttention: false,
    activeVersion: 1,
    netPnl: null,
    createdAt: NOW,
    updatedAt: NOW,
  } as BotSummary;
}

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <main>{ui}</main>
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.calls = [];
  state.config = { ...baselineVersionConfig(), sizeUsdc: "50", leverage: 10 };
  replace.mockReset();
});
afterEach(() => {
  cleanup();
});

describe("Trading Agent · news bot (#470)", () => {
  it("Configuration shows the running config read-only and links to Signal Research", async () => {
    wrap(<NewsConfigBody botId={BOT_ID} />);
    expect(await screen.findByText("10×, isolated")).toBeInTheDocument();
    expect(screen.getByText("5 USDC")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Open in Signal Research" });
    expect(link).toHaveAttribute("href", `/signal-research?bots=mainnet&bot=${BOT_ID}&settings=1`);
    expect(screen.queryByRole("link", { name: /Edit bot/ })).toBeNull();
    const r = await axe.run(document.body, { rules: { "color-contrast": { enabled: false } } });
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });

  it("Stop opens the news bot dialog (Keep open trades / Close all now) and sends closePosition", async () => {
    const user = userEvent.setup();
    wrap(<NewsStopBlock bot={bot()} title="Stop this bot" />);
    expect(screen.getByText(M.dialogs.stop.body)).toBeInTheDocument();
    expect(screen.queryByText(/Cancels its open orders/)).toBeNull();
    await user.click(screen.getByRole("button", { name: M.strip.stop }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(M.dialogs.stop.keepTitle)).toBeInTheDocument();
    const confirm = within(dialog).getByRole("button", { name: M.dialogs.stop.cta });
    expect(confirm).toBeDisabled();
    await user.click(within(dialog).getByRole("radio", { name: M.dialogs.stop.keepTitle }));
    await user.click(confirm);
    await waitFor(() => {
      const c = state.calls.find((x) => x.path.endsWith("/actions/stop"));
      expect(c?.body).toEqual({ closePosition: false });
    });
    const r = await axe.run(document.body, { rules: { "color-contrast": { enabled: false } } });
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });

  it("/bots/:id/edit sends a news bot to Signal Research instead of an empty page", async () => {
    wrap(<BotEdit botId={BOT_ID} />);
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith(signalResearchBotHref(BOT_ID));
    });
    expect(screen.queryByRole("form")).toBeNull();
  });

  it("the Signal Research link selects the bot and opens Settings; junk ids are ignored", () => {
    expect(linkTarget(`?bots=mainnet&bot=${BOT_ID}&settings=1`)).toEqual({
      bot: BOT_ID,
      settings: true,
    });
    expect(linkTarget("?bots=mainnet&bot=nope")).toEqual({ bot: null, settings: false });
    expect(linkTarget("")).toEqual({ bot: null, settings: false });
  });
});
