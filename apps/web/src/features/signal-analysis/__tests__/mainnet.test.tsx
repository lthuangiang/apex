// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  baselineVersionConfig,
  type BotSummary,
  type ErrorCode,
  type NewsTrade,
} from "@drift/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";

import messages from "../../../../messages/en.json";
import { NewsBotEditor } from "../mainnet/bot-editor";
import { MainnetPanel, ModeSwitch } from "../mainnet/mainnet-panel";
import { MainnetTrades } from "../mainnet/mainnet-trades";
import { Signals24h } from "../mainnet/signals-24h";
import { botConfigOf, draftOf, validateBot } from "../research/version-sheet";

import { BASELINE_ID, MARKETS, VERSIONS } from "./versions-fixtures";

// #421: phần Mainnet của Signal research. API giả (#443) trả dữ liệu qua đúng zod schema; không kiểm câu chữ nằm trong
// `_pendingReview` (PM chốt), chỉ kiểm vai trò / trạng thái / câu đã duyệt ("Mainnet bots are not available yet.").

const BOT_ID = "11111111-1111-4111-8111-111111111111";
const TRADE_ID = "22222222-2222-4222-8222-222222222222";
const SIGNAL_ID = "33333333-3333-4333-8333-333333333333";
const NOT_READY = "Mainnet bots are not available yet.";
// Câu chữ mới đang chờ PM duyệt: đọc từ en.json để test không phụ thuộc chữ cụ thể.
const M = messages.signalAnalysis.research.mainnet;

const state = vi.hoisted(
  (): {
    calls: { method: string; path: string; body: unknown }[];
    bots: unknown[];
    trades: unknown[];
    signals: unknown[];
    fail: Record<
      string,
      { code: ErrorCode | "NETWORK"; status: number; details?: Record<string, unknown> }
    >;
  } => ({ calls: [], bots: [], trades: [], signals: [], fail: {} }),
);

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...real,
    api: (method: string, path: string, schema: z.ZodType, opts?: { body?: unknown }) => {
      state.calls.push({ method, path, body: opts?.body });
      const p = new URL(path, "http://x").pathname;
      const key = `${method} ${p}`;
      const f = Object.entries(state.fail).find(([k]) => key.endsWith(k))?.[1];
      if (f !== undefined)
        return Promise.reject(new real.ApiError(f.code, f.status, f.details ?? {}));
      if (p.endsWith("/signal-research/versions")) return Promise.resolve(schema.parse(VERSIONS));
      if (p.endsWith("/signal-research/markets")) return Promise.resolve(schema.parse(MARKETS));
      if (method === "GET" && p === "/api/v1/signal-research/bots")
        return Promise.resolve(schema.parse({ items: state.bots }));
      if (p.endsWith("/trades") && method === "GET")
        return Promise.resolve(schema.parse({ items: state.trades }));
      if (p.endsWith("/signals")) return Promise.resolve(schema.parse({ items: state.signals }));
      if (p.endsWith(`/bots/${BOT_ID}`))
        return Promise.resolve(
          schema.parse({ ...BOT_DETAIL, bot: bot(), versions: [{ ...VERSION_ROW }] }),
        );
      if (method === "POST" && p.endsWith("/close"))
        return Promise.resolve(schema.parse(command("close", null, null)));
      if (method === "POST" && p.endsWith("/tpsl")) {
        const b = opts?.body as { tp: string | null; sl: string | null };
        return Promise.resolve(schema.parse(command("edit_tpsl", b.tp, b.sl)));
      }
      if (method === "POST" && p.includes("/actions/"))
        return Promise.resolve(schema.parse(bot({ state: "starting" })));
      if (method === "POST" && p === "/api/v1/signal-research/bots")
        return Promise.resolve(schema.parse(bot({ state: "draft" })));
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
vi.mock("@/lib/markets", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useMarketLast: () => ({ data: { market: "SOL-USD", price: "211.80", at: 1 } }),
}));
vi.mock("@/lib/use-media", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useMediaQuery: () => false,
}));

const NOW = "2026-11-22T10:00:00.000Z";
function bot(over: Partial<BotSummary> = {}) {
  return {
    id: BOT_ID,
    name: "News · Baseline (v3)",
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
    ...over,
  };
}
const CONFIG = {
  ...baselineVersionConfig(),
  sizeUsdc: "100",
  leverage: 1,
  maxOpenTrades: 3,
  maxNewTradesPerDay: 5,
};
const VERSION_ROW = {
  id: "44444444-4444-4444-8444-444444444444",
  version: 1,
  config: CONFIG,
  paramSource: "manual",
  status: "active",
  appliedAt: NOW,
  createdAt: NOW,
};
const BOT_DETAIL = { events: [], openOrders: 0, serverTime: NOW, recentErrors: [] };
function trade(over: Partial<NewsTrade> = {}): NewsTrade {
  return {
    id: TRADE_ID,
    signalId: SIGNAL_ID,
    market: "SOL-USD",
    side: "short",
    status: "open",
    sizeUsdc: "100",
    leverage: null,
    qty: "0.47",
    entryAvgPrice: "212.4",
    tpPrice: "205.1",
    slPrice: "216.05",
    maxHoldUntil: "2026-11-22T23:42:00.000Z",
    openedAt: "2026-11-22T21:42:00.000Z",
    closedAt: null,
    closeReason: null,
    exitAvgPrice: null,
    pendingCommand: null,
    ...over,
  };
}
function command(kind: "close" | "edit_tpsl", tp: string | null, sl: string | null) {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    tradeId: TRADE_ID,
    kind,
    seq: 1,
    tp,
    sl,
    status: "queued",
    createdAt: NOW,
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

async function noViolations(container: HTMLElement = document.body) {
  const r = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
  expect(r.violations.map((v) => v.id)).toEqual([]);
}

beforeEach(() => {
  state.calls = [];
  state.bots = [bot()];
  state.trades = [trade()];
  state.signals = [];
  state.fail = {};
});
afterEach(() => {
  cleanup();
});

describe("Paper / Mainnet switch and the bot strip", () => {
  it("switches mode, lists only my mainnet bots, and Pause sends the action (state from the backend)", async () => {
    const onMode = vi.fn();
    const user = userEvent.setup();
    wrap(
      <MainnetPanel
        sources={null}
        tz="UTC"
        modeSwitch={<ModeSwitch mode="mainnet" onMode={onMode} />}
        bots={[bot() as BotSummary]}
        botsLoading={false}
        botsError={null}
        selected={bot() as BotSummary}
        onBot={() => undefined}
        onHow={() => undefined}
        onStartFromVersion={() => undefined}
      />,
    );
    const sw = screen.getByRole("radiogroup", { name: M.mode.label });
    expect(within(sw).getByRole("radio", { name: M.mode.mainnet })).toBeChecked();
    await user.click(within(sw).getByRole("radio", { name: M.mode.paper }));
    expect(onMode).toHaveBeenCalledWith("paper");
    const select = screen.getByRole("combobox", { name: M.bot });
    expect(within(select).getAllByRole("option")).toHaveLength(1);
    // Kết quả không có dữ liệu (#443): "Not available", không bao giờ 0.
    const strip = screen.getByRole("group", { name: M.strip.label });
    expect(within(strip).getByText("Not available")).toBeInTheDocument();
    expect(within(strip).queryByText(/\b0(\.0+)? USDC/)).not.toBeInTheDocument();
    await waitFor(() => {
      expect(within(strip).getByText(M.strip.open.replace("{n}", "1"))).toBeInTheDocument();
    });
    await user.click(within(strip).getByRole("button", { name: M.strip.pause }));
    await waitFor(() => {
      expect(
        state.calls.some(
          (c) => c.method === "POST" && c.path.endsWith(`/bots/${BOT_ID}/actions/pause`),
        ),
      ).toBe(true);
    });
    await noViolations();
  });

  it("Stop… asks Keep open trades or Close all now and sends closePosition", async () => {
    const user = userEvent.setup();
    wrap(
      <MainnetPanel
        sources={null}
        tz="UTC"
        modeSwitch={null}
        bots={[bot() as BotSummary]}
        botsLoading={false}
        botsError={null}
        selected={bot() as BotSummary}
        onBot={() => undefined}
        onHow={() => undefined}
        onStartFromVersion={() => undefined}
      />,
    );
    await user.click(screen.getByRole("button", { name: M.strip.stop }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: M.dialogs.stop.cta });
    expect(confirm).toBeDisabled();
    await user.click(within(dialog).getByRole("radio", { name: M.dialogs.stop.closeTitle }));
    await user.click(confirm);
    await waitFor(() => {
      const c = state.calls.find((x) => x.path.endsWith("/actions/stop"));
      expect(c?.body).toEqual({ closePosition: true });
    });
  });

  it("a Draft bot starts from the strip; 409 FEATURE_NOT_READY shows the approved sentence", async () => {
    state.fail = { "/actions/start": { code: "FEATURE_NOT_READY", status: 409 } };
    const user = userEvent.setup();
    const draft = bot({ state: "draft" }) as BotSummary;
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
    expect(screen.getByText("Draft")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: M.strip.start }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: M.dialogs.start.cta });
    expect(confirm).toBeDisabled();
    await user.click(within(dialog).getByRole("checkbox"));
    await user.click(confirm);
    expect(await within(dialog).findByText(NOT_READY)).toBeInTheDocument();
    await noViolations();
  });
});

describe("Mainnet trades", () => {
  it("shows Not available for results, Edit TP/SL validates and sends only changed prices", async () => {
    const user = userEvent.setup();
    wrap(<MainnetTrades botId={BOT_ID} tz="UTC" />);
    const table = await screen.findByRole("table");
    const row = within(table).getAllByRole("row")[1];
    if (row === undefined) throw new Error("row");
    expect(within(row).getByText("Not available")).toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: M.trades.edit }));
    const dialog = await screen.findByRole("dialog");
    const sl = within(dialog).getByRole("textbox", { name: M.dialogs.edit.sl });
    // Short: SL phải trên TP.
    await user.clear(sl);
    await user.type(sl, "200");
    await user.click(within(dialog).getByRole("button", { name: M.dialogs.edit.save }));
    expect(within(dialog).getByRole("alert")).toBeInTheDocument();
    expect(state.calls.some((c) => c.path.endsWith("/tpsl"))).toBe(false);
    await user.clear(sl);
    await user.type(sl, "218");
    await user.click(within(dialog).getByRole("button", { name: M.dialogs.edit.save }));
    await waitFor(() => {
      const c = state.calls.find((x) => x.path.endsWith("/tpsl"));
      expect(c?.body).toEqual({ tp: null, sl: "218" });
    });
    await noViolations();
  });

  it("Close now confirms like Stop; a queued command keeps a transitional label until the backend confirms", async () => {
    const user = userEvent.setup();
    const view = wrap(<MainnetTrades botId={BOT_ID} tz="UTC" />);
    await user.click(await screen.findByRole("button", { name: M.trades.close }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: M.trades.close }));
    await waitFor(() => {
      expect(
        state.calls.some(
          (c) => c.method === "POST" && c.path.endsWith(`/trades/${TRADE_ID}/close`),
        ),
      ).toBe(true);
    });
    view.unmount();
    state.trades = [
      trade({ pendingCommand: command("close", null, null) as NewsTrade["pendingCommand"] }),
    ];
    wrap(<MainnetTrades botId={BOT_ID} tz="UTC" />);
    const status = await screen.findByRole("status");
    expect(status).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: M.trades.close })).not.toBeInTheDocument();
  });

  it("closed trades the engine blocked show the approved reason label, never the generic Closed (#419 B2)", async () => {
    const codes = [
      "NEWS_ORDER_INVALID",
      "NEWS_CAP_EXCEEDED",
      "NEWS_ACCESS_OFF",
      "BOT_NOT_RUNNING",
      "LEVERAGE_NOT_SET",
    ] as const;
    state.trades = codes.map((closeReason, i) =>
      trade({
        id: `6666666${String(i)}-6666-4666-8666-666666666666`,
        signalId: `7777777${String(i)}-7777-4777-8777-777777777777`,
        status: "closed",
        qty: "0",
        entryAvgPrice: null,
        closedAt: NOW,
        closeReason,
      }),
    );
    wrap(<MainnetTrades botId={BOT_ID} tz="UTC" />);
    const table = await screen.findByRole("table");
    expect(M.trades.reasons.NEWS_ORDER_INVALID).toBe("Entry blocked by a safety check");
    expect(M.trades.reasons.NEWS_CAP_EXCEEDED).toBe("Entry blocked by a safety check");
    expect(M.trades.reasons.NEWS_ACCESS_OFF).toBe("Signal Research access is off");
    expect(M.trades.reasons.BOT_NOT_RUNNING).toBe("Bot was not running");
    expect(M.trades.reasons.LEVERAGE_NOT_SET).toBe("Leverage couldn’t be set to 1×");
    expect(within(table).getAllByText("Entry blocked by a safety check")).toHaveLength(2);
    expect(within(table).getByText("Signal Research access is off")).toBeInTheDocument();
    expect(within(table).getByText("Bot was not running")).toBeInTheDocument();
    expect(within(table).getByText("Leverage couldn’t be set to 1×")).toBeInTheDocument();
    expect(within(table).queryByText(M.trades.reasons.other)).toBeNull();
  });

  it("empty and 404 states", async () => {
    state.trades = [];
    const a = wrap(<MainnetTrades botId={BOT_ID} tz="UTC" />);
    await waitFor(() => {
      expect(screen.queryByRole("table")).not.toBeInTheDocument();
      expect(state.calls.some((c) => c.path.endsWith("/trades"))).toBe(true);
    });
    a.unmount();
    state.fail = { "/trades": { code: "BOT_NOT_FOUND", status: 404 } };
    wrap(<MainnetTrades botId={BOT_ID} tz="UTC" />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});

describe("Signals in the last 24 h", () => {
  it("uses the funnel reason labels, the bot reason labels, and the raw code only when neither has one", async () => {
    state.signals = [
      {
        id: SIGNAL_ID,
        market: "SOL-USD",
        catalyst: "listing",
        side: "long",
        level: "high",
        decidedAt: NOW,
        expiresAt: NOW,
        outcome: "dropped",
        reason: "LEVEL_TOO_LOW",
      },
      {
        id: "66666666-6666-4666-8666-666666666666",
        market: "BTC-USD",
        catalyst: "listing",
        side: "long",
        level: "low",
        decidedAt: NOW,
        expiresAt: NOW,
        outcome: "dropped",
        reason: "ASSET_NOT_IN_BOT",
      },
      {
        id: "77777777-7777-4777-8777-777777777777",
        market: "ETH-USD",
        catalyst: "listing",
        side: "long",
        level: "low",
        decidedAt: NOW,
        expiresAt: NOW,
        outcome: "dropped",
        reason: "SOME_FUTURE_CODE",
      },
    ];
    wrap(<Signals24h botId={BOT_ID} tz="UTC" />);
    const list = await screen.findByRole("list");
    const funnelLabel =
      (messages.signalAnalysis.research.trace.reasonLabels as Record<string, string>).levelTooLow ??
      "";
    expect(within(list).getByText(new RegExp(funnelLabel))).toBeInTheDocument();
    // Nhãn riêng của bot (PM duyệt ở review #445): không hiện mã thô.
    expect(
      within(list).getByText(new RegExp(M.signals.reasons.ASSET_NOT_IN_BOT)),
    ).toBeInTheDocument();
    expect(within(list).queryByText(/ASSET_NOT_IN_BOT/)).not.toBeInTheDocument();
    // Mã chưa có nhãn nào: fallback "Skipped ({code})".
    expect(within(list).getByText(/SOME_FUTURE_CODE/)).toBeInTheDocument();
  });
});

describe("Start bot from a version (version editor, bot fields)", () => {
  const base = VERSIONS.items.find((v) => v.id === BASELINE_ID);
  if (base === undefined) throw new Error("fixture");

  it("validates the 200 USDC cap and narrowing like the API", () => {
    const narrow = {
      ...baselineVersionConfig(),
      minLevel: "medium" as const,
      assets: { mode: "only" as const, markets: ["SOL-USD"], crypto: true, stocks: true },
    };
    const d = draftOf(narrow, "Bot");
    expect(validateBot({ ...d, size: "201" }, narrow).size).toEqual({ key: "sizeCap" });
    expect(validateBot({ ...d, size: "200" }, narrow).size).toBeUndefined();
    expect(validateBot({ ...d, mode: "all", markets: [] }, narrow).assets).toEqual({
      key: "narrowMarkets",
    });
    expect(validateBot({ ...d, minLevel: "low" }, narrow).minLevel).toEqual({ key: "raiseLevel" });
    expect(validateBot({ ...d, minLevel: "high" }, narrow).minLevel).toBeUndefined();
    expect(botConfigOf({ ...d, size: "100" }, narrow)).toMatchObject({
      sizeUsdc: "100",
      leverage: 1,
    });
  });

  it("creates the bot then starts it; a 409 keeps the editor open with the approved sentence and no second bot", async () => {
    state.fail = { "/actions/start": { code: "FEATURE_NOT_READY", status: 409 } };
    const user = userEvent.setup();
    const onStarted = vi.fn();
    wrap(
      <NewsBotEditor
        from={base}
        versions={VERSIONS.items}
        onClose={() => undefined}
        onStarted={onStarted}
      />,
    );
    const dialog = await screen.findByRole("dialog");
    const name = within(dialog).getAllByRole("textbox")[0];
    if (name === undefined) throw new Error("name");
    await user.type(name, "My news bot");
    // Size mặc định của version là 500: vượt trần 200.
    const start = within(dialog).getAllByRole("button", { name: M.editor.start }).at(-1);
    if (start === undefined) throw new Error("start");
    expect(start).toBeDisabled();
    await user.click(within(dialog).getByRole("checkbox", { name: M.dialogs.start.ack }));
    await user.click(start);
    expect(
      state.calls.some((c) => c.method === "POST" && c.path === "/api/v1/signal-research/bots"),
    ).toBe(false);
    const size = within(dialog)
      .getAllByRole("textbox")
      .find((x) => (x as HTMLInputElement).value === "500");
    if (size === undefined) throw new Error("size");
    await user.clear(size);
    await user.type(size, "150");
    await user.click(start);
    expect(await within(dialog).findByText(NOT_READY)).toBeInTheDocument();
    const creates = () =>
      state.calls.filter((c) => c.method === "POST" && c.path === "/api/v1/signal-research/bots");
    expect(creates()).toHaveLength(1);
    expect(creates()[0]?.body).toMatchObject({
      versionId: BASELINE_ID,
      name: "My news bot",
      config: { sizeUsdc: "150", leverage: 1, onOppositeNews: "keep" },
    });
    expect(onStarted).toHaveBeenCalledWith(BOT_ID);
    // Bấm lại: chỉ Start lại bot đã tạo.
    await user.click(start);
    await waitFor(() => {
      expect(state.calls.filter((c) => c.path.endsWith("/actions/start"))).toHaveLength(2);
    });
    expect(creates()).toHaveLength(1);
  });
});
