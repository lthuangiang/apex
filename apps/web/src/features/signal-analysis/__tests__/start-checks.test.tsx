// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { baselineVersionConfig, type BotSummary, type StartChecks } from "@drift/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";

import messages from "../../../../messages/en.json";
import { MainnetPanel } from "../mainnet/mainnet-panel";

// #459: hộp "Start v1?" của bot Mainnet đọc `GET /bots/:id/checks` và nói rõ check nào chưa đạt (câu PM duyệt), đang tải,
// lỗi tải, đọc lại sau khi Start lỗi, axe.

const BOT_ID = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-11-22T10:00:00.000Z";
const M = messages.signalAnalysis.research.mainnet;
const C = M.dialogs.start.checks;
const BS = messages.createBot.beforeStart;

type Check = StartChecks["checks"][number];
const ok: Check[] = [
  { key: "api_key", ok: true, detail: null },
  { key: "builder_fee", ok: true, detail: null },
  {
    key: "balance",
    ok: true,
    detail: "500",
    data: { available: "500", needed: "300", marginMode: "isolated" },
  },
  { key: "leverage_conflict", ok: true, detail: "none" },
];

const state = vi.hoisted(
  (): {
    checks: unknown;
    checksMode: "ok" | "pending" | "error";
    checkCalls: number;
    startFails: boolean;
    config: Record<string, unknown> | null;
  } => ({ checks: null, checksMode: "ok", checkCalls: 0, startFails: false, config: null }),
);

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...real,
    api: (method: string, path: string, schema: z.ZodType) => {
      const p = new URL(path, "http://x").pathname;
      if (p.endsWith(`/bots/${BOT_ID}/checks`)) {
        state.checkCalls += 1;
        if (state.checksMode === "pending") return new Promise(() => undefined);
        if (state.checksMode === "error")
          return Promise.reject(new real.ApiError("INTERNAL_ERROR", 500));
        return Promise.resolve(schema.parse(state.checks));
      }
      if (method === "POST" && p.endsWith("/actions/start")) {
        if (state.startFails)
          return Promise.reject(
            new real.ApiError("VALIDATION_FAILED", 422, { failed: ["balance"] }),
          );
        return Promise.resolve(schema.parse(bot("starting")));
      }
      if (p.endsWith(`/bots/${BOT_ID}`) && state.config !== null)
        return Promise.resolve(
          schema.parse({
            events: [],
            openOrders: 0,
            serverTime: NOW,
            recentErrors: [],
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
          }),
        );
      if (p.endsWith("/trades") || p.endsWith("/signals"))
        return Promise.resolve(schema.parse({ items: [] }));
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
  useTwoFactorNeeded: () => false,
}));

function bot(s = "draft") {
  return {
    id: BOT_ID,
    name: "News · Baseline (v3)",
    strategy: "news_signal",
    market: "",
    engine: "perps",
    state: s,
    reasonCode: null,
    needsAttention: false,
    activeVersion: 1,
    netPnl: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function checksWith(over: Check) {
  return {
    checks: ok.map((c) => (c.key === over.key ? over : c)),
    allOk: false,
  };
}

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        {ui}
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

async function openStart() {
  const draft = bot() as BotSummary;
  wrap(
    <MainnetPanel
      sources={null}
      tz="UTC"
      modeSwitch={null}
      bots={[draft]}
      botsLoading={false}
      botsError={null}
      selected={draft}
      onBot={() => undefined}
      onHow={() => undefined}
      onStartFromVersion={() => undefined}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: M.strip.start }));
  return screen.findByRole("dialog");
}

const row = (dialog: HTMLElement, key: string) => {
  const li = dialog.querySelector<HTMLElement>(`[data-check="${key}"]`);
  if (li === null) throw new Error(`no row ${key}`);
  return li;
};

beforeEach(() => {
  state.checks = { checks: ok, allOk: true };
  state.checksMode = "ok";
  state.checkCalls = 0;
  state.startFails = false;
  state.config = null;
});
afterEach(() => {
  cleanup();
});

describe("Start dialog checks (#459)", () => {
  it("lists every check with ✓ when all pass", async () => {
    const dialog = await openStart();
    const list = await within(dialog).findByRole("list", { name: BS.title });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(4);
    for (const li of items) expect(li.querySelector("[data-status='pass']")).not.toBeNull();
    expect(row(dialog, "api_key")).toHaveTextContent(`${BS.passed}: ${BS.api_key}`);
  });

  it("api_key: says the key isn't ready and links to Settings", async () => {
    state.checks = checksWith({ key: "api_key", ok: false, detail: "missing" });
    const dialog = await openStart();
    await waitFor(() => {
      expect(row(dialog, "api_key")).toHaveTextContent(C.apiKey);
    });
    expect(row(dialog, "api_key").querySelector("[data-status='fail']")).not.toBeNull();
    expect(within(row(dialog, "api_key")).getByRole("link")).toHaveAttribute("href", "/settings");
  });

  it("builder_fee: uses the existing approve sentence", async () => {
    state.checks = checksWith({ key: "builder_fee", ok: false, detail: null });
    const dialog = await openStart();
    await waitFor(() => {
      expect(row(dialog, "builder_fee")).toHaveTextContent(messages.createBot.errors.builderFee);
    });
  });

  it("balance: shows available and needed, and Not available instead of 0", async () => {
    state.checks = checksWith({
      key: "balance",
      ok: false,
      detail: "120",
      data: { available: "120", needed: "300", marginMode: "isolated" },
    });
    const dialog = await openStart();
    await waitFor(() => {
      expect(row(dialog, "balance")).toHaveTextContent(
        "Isolated margin: 120.00 USDC available, 300.00 USDC needed.",
      );
    });
    cleanup();
    state.checks = checksWith({
      key: "balance",
      ok: false,
      detail: null,
      data: { available: null, needed: "300", marginMode: "isolated" },
    });
    const again = await openStart();
    await waitFor(() => {
      expect(row(again, "balance")).toHaveTextContent(
        "Isolated margin: 300.00 USDC needed. Available: Not available.",
      );
    });
    expect(row(again, "balance")).not.toHaveTextContent(/\b0(\.00)? USDC available/);
  });

  it("leverage_conflict: names the other bot and market; other kinds use the existing sentence", async () => {
    state.checks = checksWith({
      key: "leverage_conflict",
      ok: false,
      detail: "bot",
      data: { market: "SOL-USD", botName: "Grid SOL" },
    });
    const dialog = await openStart();
    await waitFor(() => {
      expect(row(dialog, "leverage_conflict")).toHaveTextContent(
        "SOL-USD is used by your bot “Grid SOL”. Remove SOL-USD from Markets or stop that bot.",
      );
    });
    cleanup();
    state.checks = checksWith({
      key: "leverage_conflict",
      ok: false,
      detail: "unavailable",
      data: {},
    });
    const again = await openStart();
    await waitFor(() => {
      expect(row(again, "leverage_conflict")).toHaveTextContent(M.errors.leverageConflict);
    });
  });

  it("shows Loading… while the checks load", async () => {
    state.checksMode = "pending";
    const dialog = await openStart();
    expect(within(dialog).getByRole("status")).toHaveTextContent(M.loading);
  });

  it("says why when the checks can't load; Start still works", async () => {
    state.checksMode = "error";
    const dialog = await openStart();
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).not.toBe("");
    expect(within(dialog).queryByRole("list", { name: BS.title })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: M.dialogs.start.cta })).toBeInTheDocument();
  });

  it("reads the checks again after Start fails, and keeps the summary line", async () => {
    state.checks = checksWith({
      key: "balance",
      ok: false,
      detail: "120",
      data: { available: "120", needed: "300", marginMode: "isolated" },
    });
    state.startFails = true;
    const user = userEvent.setup();
    const dialog = await openStart();
    await waitFor(() => {
      expect(row(dialog, "balance")).toHaveTextContent("120.00 USDC available");
    });
    const before = state.checkCalls;
    await user.click(within(dialog).getByRole("checkbox"));
    await user.click(within(dialog).getByRole("button", { name: M.dialogs.start.cta }));
    expect(await within(dialog).findByText(messages.createBot.errors.checks)).toBeInTheDocument();
    await waitFor(() => {
      expect(state.checkCalls).toBeGreaterThan(before);
    });
  });

  it("has no axe violations with a failing check", async () => {
    state.checks = checksWith({ key: "api_key", ok: false, detail: "missing" });
    const dialog = await openStart();
    await waitFor(() => {
      expect(row(dialog, "api_key")).toHaveTextContent(C.apiKey);
    });
    const r = await axe.run(document.body, { rules: { "color-contrast": { enabled: false } } });
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });
  it("#458: the margin row shows the size × open ÷ leverage formula once the bot config is read", async () => {
    state.config = { ...baselineVersionConfig(), sizeUsdc: "150", leverage: 5, maxOpenTrades: 2 };
    const dialog = await openStart();
    await waitFor(() => {
      expect(within(row(dialog, "balance")).getByTestId("margin-formula")).toBeInTheDocument();
    });
    cleanup();
    state.config = null;
    const again = await openStart();
    await within(again).findByRole("list", { name: BS.title });
    expect(within(again).queryByTestId("margin-formula")).toBeNull();
  });
});
