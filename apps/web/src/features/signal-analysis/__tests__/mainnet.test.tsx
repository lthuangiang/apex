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
import { editConfigOf, editDraftOf, validateEdit } from "../mainnet/bot-edit";
import { NewsBotEditor } from "../mainnet/bot-editor";
import { MainnetPanel, ModeSwitch } from "../mainnet/mainnet-panel";
import { MainnetTrades } from "../mainnet/mainnet-trades";
import { Signals24h } from "../mainnet/signals-24h";
import { botConfigOf, draftOf, validateBot } from "../research/version-sheet";

import { BASELINE_ID, MARKETS, V4, V4_ID, VERSIONS } from "./versions-fixtures";

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
    calls: { method: string; path: string; body: unknown; idempotencyKey?: string | undefined }[];
    bots: unknown[];
    trades: unknown[];
    signals: unknown[];
    fail: Record<
      string,
      { code: ErrorCode | "NETWORK"; status: number; details?: Record<string, unknown> }
    >;
    /** Config của version đang chạy của bot; null = CONFIG. */
    config: Record<string, unknown> | null;
    /** #469: version `pending` (đang chờ engine áp); null = không có. */
    pending: number | null;
    /** #469: kết quả `POST /bots/:id/versions`. */
    saved: Record<string, unknown>;
  } => ({
    calls: [],
    bots: [],
    trades: [],
    signals: [],
    fail: {},
    config: null,
    pending: null,
    saved: {},
  }),
);

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...real,
    api: (
      method: string,
      path: string,
      schema: z.ZodType,
      opts?: { body?: unknown; idempotencyKey?: string },
    ) => {
      state.calls.push({ method, path, body: opts?.body, idempotencyKey: opts?.idempotencyKey });
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
          schema.parse({
            ...BOT_DETAIL,
            bot: bot(),
            versions: [
              { ...VERSION_ROW, config: state.config ?? CONFIG },
              ...(state.pending === null
                ? []
                : [
                    {
                      ...VERSION_ROW,
                      id: "66666666-6666-4666-8666-666666666666",
                      version: state.pending,
                      status: "pending",
                      appliedAt: null,
                    },
                  ]),
            ],
          }),
        );
      if (method === "POST" && p.endsWith(`/bots/${BOT_ID}/versions`))
        return Promise.resolve(schema.parse(state.saved));
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
  state.config = null;
  state.pending = null;
  state.saved = {
    version: 2,
    status: "pending",
    balance: { ok: true, available: "500", needed: "20" },
  };
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
    // #458: lệnh không kèm đòn bẩy (lệnh cũ) dùng câu không số; có số thì "… to {lev}×" (test ở leverage.test.tsx).
    expect(M.trades.reasons.LEVERAGE_NOT_SET).toBe("Leverage couldn’t be set");
    expect(within(table).getAllByText("Entry blocked by a safety check")).toHaveLength(2);
    expect(within(table).getByText("Signal Research access is off")).toBeInTheDocument();
    expect(within(table).getByText("Bot was not running")).toBeInTheDocument();
    expect(within(table).getByText("Leverage couldn’t be set")).toBeInTheDocument();
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

describe("leverage 1 / 5 / 10 / 20 (#458)", () => {
  const found = VERSIONS.items.find((v) => v.id === BASELINE_ID);
  if (found === undefined) throw new Error("fixture");
  const base = found;
  const E = M.editor;

  async function openEditor() {
    const user = userEvent.setup();
    wrap(
      <NewsBotEditor
        from={base}
        versions={VERSIONS.items}
        onClose={() => undefined}
        onStarted={() => undefined}
      />,
    );
    const dialog = await screen.findByRole("dialog");
    const size = within(dialog)
      .getAllByRole("textbox")
      .find((x) => (x as HTMLInputElement).value === "500");
    if (size === undefined) throw new Error("size");
    await user.clear(size);
    await user.type(size, "150");
    return { user, dialog };
  }

  it("picks 1× / 5× / 10× / 20×; margin follows size ÷ leverage; the liquidation note shows above 1×", async () => {
    const { user, dialog } = await openEditor();
    const group = within(dialog).getByRole("radiogroup", { name: E.leverage });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual(["1×", "5×", "10×", "20×"]);
    expect(within(group).getByRole("radio", { name: "1×" })).toBeChecked();
    expect(within(dialog).getByText(E.leverageHelp)).toBeInTheDocument();
    expect(within(dialog).getByText(E.size)).toBeInTheDocument();
    const calc = within(dialog).getByTestId("margin-calc");
    expect(calc).toHaveTextContent("Margin per trade (150 ÷ 1×)150 USDC");
    expect(within(dialog).queryByText(/a trade is skipped if its stop loss/)).toBeNull();

    await user.click(within(group).getByRole("radio", { name: "5×" }));
    expect(within(group).getByRole("radio", { name: "5×" })).toBeChecked();
    expect(calc).toHaveTextContent("Margin per trade (150 ÷ 5×)30 USDC");
    const maxOpen = within(dialog).getByRole("textbox", { name: /Max open trades/ });
    await user.clear(maxOpen);
    await user.type(maxOpen, "2");
    expect(calc).toHaveTextContent("Margin needed for 2 open trades60 USDC");
    expect(
      within(dialog).getByText(
        "At 5×, a trade is skipped if its stop loss would sit beyond the liquidation price.",
      ),
    ).toBeInTheDocument();

    await user.click(within(group).getByRole("radio", { name: "20×" }));
    expect(calc).toHaveTextContent("Margin per trade (150 ÷ 20×)7.5 USDC");
    expect(calc).toHaveTextContent("15 USDC");
    const r = await axe.run(dialog, { rules: { "color-contrast": { enabled: false } } });
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });

  it("sends the picked leverage when the bot is created", async () => {
    const { user, dialog } = await openEditor();
    const name = within(dialog).getAllByRole("textbox")[0];
    if (name === undefined) throw new Error("name");
    await user.type(name, "Lev bot");
    await user.click(
      within(within(dialog).getByRole("radiogroup", { name: E.leverage })).getByRole("radio", {
        name: "10×",
      }),
    );
    await user.click(within(dialog).getByRole("checkbox", { name: M.dialogs.start.ack }));
    const start = within(dialog).getAllByRole("button", { name: E.start }).at(-1);
    if (start === undefined) throw new Error("start");
    await user.click(start);
    await waitFor(() => {
      const c = state.calls.find(
        (x) => x.method === "POST" && x.path === "/api/v1/signal-research/bots",
      );
      expect(c?.body).toMatchObject({ config: { sizeUsdc: "150", leverage: 10 } });
    });
  });

  it("the config line shows the bot's leverage; an old bot without the field reads 1×", async () => {
    const old: Record<string, unknown> = { ...CONFIG };
    delete old.leverage;
    state.config = old;
    const one = bot() as BotSummary;
    const panel = () => (
      <MainnetPanel
        sources={null}
        tz="UTC"
        modeSwitch={null}
        bots={[one]}
        botsLoading={false}
        botsError={null}
        selected={one}
        onBot={() => undefined}
        onHow={() => undefined}
        onStartFromVersion={() => undefined}
      />
    );
    wrap(panel());
    expect(
      await screen.findByText("Size 100 USDC · leverage 1× · max 3 open · max 5 new trades a day"),
    ).toBeInTheDocument();
    cleanup();
    state.config = { ...CONFIG, leverage: 10 };
    wrap(panel());
    expect(
      await screen.findByText("Size 100 USDC · leverage 10× · max 3 open · max 5 new trades a day"),
    ).toBeInTheDocument();
  });

  it("Mainnet trades: size · leverage when the trade has it, size only for old trades", async () => {
    state.trades = [
      trade({ id: "22222222-2222-4222-8222-222222222231", sizeUsdc: "150" }),
      {
        ...trade({
          id: "22222222-2222-4222-8222-222222222232",
          sizeUsdc: "150",
          status: "closed",
          closedAt: NOW,
          closeReason: "LEVERAGE_NOT_SET",
        }),
        leverage: 10,
      },
      { ...trade({ id: "22222222-2222-4222-8222-222222222233", sizeUsdc: "80" }), leverage: 5 },
    ];
    wrap(<MainnetTrades botId={BOT_ID} tz="UTC" />);
    const table = await screen.findByRole("table");
    expect(within(table).getByText("80 USDC · 5×")).toBeInTheDocument();
    expect(within(table).getByText("150 USDC · 10×")).toBeInTheDocument();
    expect(within(table).getByText("150 USDC")).toBeInTheDocument();
    expect(within(table).getByText("Leverage couldn’t be set to 10×")).toBeInTheDocument();
  });

  it("Signals: SL_BEYOND_LIQUIDATION has a label, never the raw code", async () => {
    state.signals = [
      {
        id: SIGNAL_ID,
        market: "SOL-USD",
        catalyst: "hack_exploit",
        side: "short",
        level: "high",
        decidedAt: NOW,
        expiresAt: NOW,
        outcome: "dropped",
        reason: "SL_BEYOND_LIQUIDATION",
      },
    ];
    wrap(<Signals24h botId={BOT_ID} tz="UTC" />);
    const list = await screen.findByRole("list");
    expect(list).not.toHaveTextContent("SL_BEYOND_LIQUIDATION");
    expect(list).toHaveTextContent("Skipped: Stop loss beyond liquidation");
  });
});

describe("Settings: view the running config (#469 part 1)", () => {
  const S = M.settings;
  const E = M.editor;

  function panel(over: Record<string, unknown> = {}) {
    const one = { ...bot(), ...over } as BotSummary & { signalVersionId?: string | null };
    return (
      <MainnetPanel
        sources={null}
        tz="UTC"
        modeSwitch={null}
        bots={[one]}
        botsLoading={false}
        botsError={null}
        selected={one}
        onBot={() => undefined}
        onHow={() => undefined}
        onStartFromVersion={() => undefined}
      />
    );
  }

  async function openSettings(over: Record<string, unknown> = {}) {
    const user = userEvent.setup();
    wrap(panel(over));
    await user.click(screen.getByRole("button", { name: S.button }));
    return screen.findByRole("dialog", { name: bot().name });
  }

  const value = (dialog: HTMLElement, label: string) => {
    const dt = within(dialog).getByText(label, { selector: "dt" });
    return dt.nextElementSibling as HTMLElement;
  };

  it("shows the version, the source version and every field of the running config, and an Edit button (#469 part 2)", async () => {
    const dialog = await openSettings({ signalVersionId: BASELINE_ID });
    expect(await within(dialog).findByText("v1 · since Nov 22, 10:00")).toBeInTheDocument();
    expect(
      await within(dialog).findByText(
        "Copied from version “v3 · Baseline”. The version keeps running on paper.",
      ),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(value(dialog, E.leverage)).toHaveTextContent("1×, isolated");
    });
    expect(value(dialog, E.account)).toHaveTextContent("••4f2a");
    expect(value(dialog, E.size)).toHaveTextContent("100 USDC");
    expect(value(dialog, S.marginPerTrade)).toHaveTextContent("100 USDC");
    expect(value(dialog, "Max open trades")).toHaveTextContent("3");
    expect(value(dialog, S.maxDay)).toHaveTextContent("5");
    expect(value(dialog, S.minLevel)).toHaveTextContent(/High|Medium|Low/);
    expect(value(dialog, S.tpsl)).toHaveTextContent(/^TP .+× · SL .+× of the typical move$/);
    expect(value(dialog, S.maxDelay)).toHaveTextContent(/^\d+ min$/);
    const table = within(dialog).getByRole("table");
    expect(within(table).getAllByRole("checkbox").length).toBeGreaterThan(0);
    for (const c of within(table).getAllByRole("checkbox")) expect(c).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: S.edit })).toBeEnabled();
    const r = await axe.run(dialog, { rules: { "color-contrast": { enabled: false } } });
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });

  it("#470: the Open in Signal Research link opens Settings of that bot right away", async () => {
    const one = bot() as BotSummary;
    wrap(
      <MainnetPanel
        openSettings
        sources={null}
        tz="UTC"
        modeSwitch={null}
        bots={[one]}
        botsLoading={false}
        botsError={null}
        selected={one}
        onBot={() => undefined}
        onHow={() => undefined}
        onStartFromVersion={() => undefined}
      />,
    );
    expect(await screen.findByRole("dialog", { name: one.name })).toBeInTheDocument();
  });

  it("10× and no daily limit: margin is size ÷ leverage and the day cap says No limit", async () => {
    state.config = { ...CONFIG, sizeUsdc: "50", leverage: 10, maxNewTradesPerDay: null };
    const dialog = await openSettings();
    await waitFor(() => {
      expect(value(dialog, E.leverage)).toHaveTextContent("10×, isolated");
    });
    expect(value(dialog, S.marginPerTrade)).toHaveTextContent("5 USDC");
    expect(value(dialog, S.maxDay)).toHaveTextContent("No limit");
  });

  it("an old bot without the leverage field reads 1×; no source version hides the Copied line", async () => {
    const old: Record<string, unknown> = { ...CONFIG };
    delete old.leverage;
    state.config = old;
    const dialog = await openSettings({ signalVersionId: null });
    await waitFor(() => {
      expect(value(dialog, E.leverage)).toHaveTextContent("1×, isolated");
    });
    expect(within(dialog).queryByText(/Copied from version/)).toBeNull();
  });

  it("a source version the viewer can't see also hides the Copied line", async () => {
    const dialog = await openSettings({ signalVersionId: "99999999-9999-4999-8999-999999999999" });
    await waitFor(() => {
      expect(value(dialog, E.leverage)).toHaveTextContent("1×, isolated");
    });
    expect(within(dialog).queryByText(/Copied from version/)).toBeNull();
  });

  it("an unreadable config shows Not available, never 0", async () => {
    state.config = { junk: true };
    const dialog = await openSettings();
    await waitFor(() => {
      expect(value(dialog, E.leverage)).toHaveTextContent("Not available");
    });
    for (const label of [E.size, S.marginPerTrade, S.maxDay, S.markets])
      expect(value(dialog, label)).toHaveTextContent("Not available");
    expect(dialog).not.toHaveTextContent(/\b0 USDC/);
  });
});

describe("Edit: save as a new version (#469 part 2)", () => {
  const S = M.settings;
  const E = M.editor;
  const one = (over: Record<string, unknown> = {}) =>
    ({ ...bot(), signalVersionId: BASELINE_ID, ...over }) as BotSummary & {
      signalVersionId?: string | null;
    };

  async function openEdit(over: Record<string, unknown> = {}) {
    const user = userEvent.setup();
    const b = one(over);
    wrap(
      <MainnetPanel
        sources={null}
        tz="UTC"
        modeSwitch={null}
        bots={[b]}
        botsLoading={false}
        botsError={null}
        selected={b}
        onBot={() => undefined}
        onHow={() => undefined}
        onStartFromVersion={() => undefined}
      />,
    );
    await user.click(screen.getByRole("button", { name: S.button }));
    const settings = await screen.findByRole("dialog", { name: b.name });
    const edit = within(settings).getByRole("button", { name: S.edit });
    await waitFor(() => {
      expect(edit).toBeEnabled();
    });
    await user.click(edit);
    const dialog = await screen.findByRole("dialog", { name: `Edit ${b.name}` });
    return { user, dialog };
  }
  const saves = () =>
    state.calls.filter((c) => c.method === "POST" && c.path.endsWith(`/bots/${BOT_ID}/versions`));

  it("validates like the API: size ≤ 200, max open 1–1000, markets only narrow, min level only rises; other fields are kept", () => {
    const current = {
      ...CONFIG,
      ...V4.config,
      sizeUsdc: "100",
      leverage: 1,
      maxOpenTrades: 3,
    } as never;
    const src = V4.config ?? null;
    const d = editDraftOf(current);
    expect(validateEdit(current, d, src)).toEqual({});
    expect(validateEdit(current, { ...d, size: "200.01" }, src).size).toEqual({ key: "sizeCap" });
    expect(validateEdit(current, { ...d, maxOpen: "0" }, src).maxOpen).toEqual({
      key: "range",
      min: 1,
      max: 1000,
    });
    expect(validateEdit(current, { ...d, minLevel: "low" }, src).minLevel).toEqual({
      key: "raiseLevel",
    });
    expect(validateEdit(current, { ...d, minLevel: "high" }, src)).toEqual({});
    // Version gốc chỉ có BTC / ETH: thêm SOL là mở rộng.
    const majors = {
      ...current,
      assets: { mode: "only", markets: ["BTC-USD"], crypto: true, stocks: true },
    } as never;
    const onlySrc = {
      ...src,
      assets: { mode: "only", markets: ["BTC-USD", "ETH-USD"], crypto: true, stocks: true },
    } as never;
    const md = editDraftOf(majors);
    expect(
      validateEdit(majors, { ...md, markets: ["BTC-USD", "SOL-USD"] }, onlySrc).assets,
    ).toEqual({
      key: "narrowMarkets",
    });
    expect(validateEdit(majors, { ...md, markets: ["ETH-USD"] }, onlySrc)).toEqual({});
    // Config gửi API: 5 ô từ form, mọi field khác đúng như version đang chạy.
    const out = editConfigOf(current, { ...d, leverage: 10, size: "50", maxOpen: "2" }, src);
    expect(out).toEqual({ ...(current as object), leverage: 10, sizeUsdc: "50", maxOpenTrades: 2 });
    expect(editConfigOf(current, { ...d, size: "300" }, src)).toBeNull();
  });

  it("shows only the 5 fields, lists the changes, and saves with paramSource manual and an Idempotency-Key; Applying v2… until the backend confirms", async () => {
    const { user, dialog } = await openEdit();
    // Lệnh đang mở (lệnh cũ chưa có đòn bẩy) giữ thiết lập lúc vào.
    expect(within(dialog).getByRole("note")).toHaveTextContent(/SOL-USD/);
    expect(within(dialog).getByRole("radiogroup", { name: E.leverage })).toBeInTheDocument();
    expect(within(dialog).getByLabelText(E.size)).toHaveValue("100");
    expect(within(dialog).getByLabelText("Max open trades")).toHaveValue("3");
    expect(within(dialog).getByLabelText(S.minLevel)).toBeInTheDocument();
    for (const gone of ["Take profit", "Stop loss", "Max source delay", "Opposite news"])
      expect(within(dialog).queryByLabelText(new RegExp(gone))).toBeNull();
    const save = within(dialog).getByRole("button", { name: "Save as v2" });
    expect(save).toBeDisabled();
    await user.click(within(dialog).getByRole("radio", { name: "5×" }));
    const size = within(dialog).getByLabelText(E.size);
    await user.clear(size);
    await user.type(size, "40");
    expect(within(dialog).getByText("Changes in v2")).toBeInTheDocument();
    expect(within(dialog).getByText("Leverage 1× → 5×")).toBeInTheDocument();
    expect(within(dialog).getByText("Position size 100 → 40 USDC")).toBeInTheDocument();
    await noViolations(dialog);
    expect(save).toBeEnabled();
    // Server: version mới `pending` tới khi engine áp.
    state.pending = 2;
    await user.click(save);
    await waitFor(() => {
      expect(saves()).toHaveLength(1);
    });
    expect(saves()[0]?.body).toEqual({
      config: { ...CONFIG, leverage: 5, sizeUsdc: "40" },
      paramSource: "manual",
    });
    expect(saves()[0]?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    // Lưu xong: về Settings, câu đã duyệt; engine chưa áp nên "Applying v2…" (trạng thái từ backend).
    const settings = await screen.findByRole("dialog", { name: bot().name });
    expect(
      within(settings).getByText(
        "Saved as v2. New signals use v2; open trades keep the settings they opened with.",
      ),
    ).toBeInTheDocument();
    const applying = await within(settings).findByText("Applying v2…", {}, { timeout: 3_000 });
    expect(applying).toBeInTheDocument();
    expect(within(settings).getByRole("button", { name: S.edit })).toBeDisabled();
  });

  it("an open trade with its leverage says so with the approved sentence", async () => {
    state.trades = [trade({ leverage: 10, market: "AAPL-USD" })];
    const { dialog } = await openEdit();
    expect(within(dialog).getByRole("note")).toHaveTextContent(
      "1 trade is open on AAPL-USD at 10×. It keeps its TP, SL, max hold and leverage. Change them with Edit TP/SL in Mainnet trades.",
    );
  });

  it("not enough isolated margin for the new config: saved anyway, with the Start box warning", async () => {
    state.saved = {
      version: 2,
      status: "pending",
      balance: { ok: false, available: "10", needed: "20" },
    };
    const { user, dialog } = await openEdit();
    await user.click(within(dialog).getByRole("radio", { name: "5×" }));
    await user.click(within(dialog).getByRole("button", { name: "Save as v2" }));
    const settings = await screen.findByRole("dialog", { name: bot().name });
    expect(within(settings).getByRole("alert")).toHaveTextContent(
      "Isolated margin: 10 USDC available, 20 USDC needed.",
    );
  });

  it("client errors stop the save and show at the field", async () => {
    state.config = { ...CONFIG, ...V4.config, sizeUsdc: "100", leverage: 1, maxOpenTrades: 3 };
    const { user, dialog } = await openEdit({ signalVersionId: V4_ID });
    const size = within(dialog).getByLabelText(E.size);
    await user.clear(size);
    await user.type(size, "250");
    await user.selectOptions(within(dialog).getByLabelText(S.minLevel), "low");
    expect(within(dialog).getByText(E.sizeCap)).toBeInTheDocument();
    expect(within(dialog).getAllByText(E.raiseLevel).length).toBeGreaterThanOrEqual(2);
    expect(within(dialog).getByLabelText(S.minLevel)).toHaveAttribute("aria-invalid", "true");
    await user.click(within(dialog).getByRole("button", { name: "Save as v2" }));
    expect(saves()).toHaveLength(0);
    await noViolations(dialog);
  });

  it("API errors: fieldErrors go to the field, leverage_conflict and a 409 while applying show a sentence", async () => {
    state.fail = {
      [`POST /api/v1/bots/${BOT_ID}/versions`]: {
        code: "VALIDATION_FAILED",
        status: 400,
        details: { fieldErrors: { minLevel: ["Can only be raised from the version."] } },
      },
    };
    const { user, dialog } = await openEdit();
    await user.click(within(dialog).getByRole("radio", { name: "5×" }));
    const save = within(dialog).getByRole("button", { name: "Save as v2" });
    await user.click(save);
    await waitFor(() => {
      expect(within(dialog).getByLabelText(S.minLevel)).toHaveAttribute("aria-invalid", "true");
    });
    state.fail = {
      [`POST /api/v1/bots/${BOT_ID}/versions`]: {
        code: "STATE_CONFLICT",
        status: 409,
        details: { reason: "leverage_conflict", market: "SOL-USD" },
      },
    };
    await user.click(within(dialog).getByRole("radio", { name: "10×" }));
    await user.click(save);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(M.errors.leverageConflict);
    state.fail = {
      [`POST /api/v1/bots/${BOT_ID}/versions`]: {
        code: "BOT_STATE_CONFLICT",
        status: 409,
        details: { reason: "applying", version: 2 },
      },
    };
    await user.click(within(dialog).getByRole("radio", { name: "20×" }));
    await user.click(save);
    await waitFor(() => {
      expect(within(dialog).getByRole("alert")).toHaveTextContent(S.stillApplying);
    });
  });

  it("asks for the 2FA code when the API needs it, then sends it", async () => {
    state.fail = {
      [`POST /api/v1/bots/${BOT_ID}/versions`]: { code: "TWO_FACTOR_REQUIRED", status: 403 },
    };
    const { user, dialog } = await openEdit();
    await user.click(within(dialog).getByRole("radio", { name: "5×" }));
    const save = within(dialog).getByRole("button", { name: "Save as v2" });
    await user.click(save);
    const code = await within(dialog).findByLabelText(M.dialogs.start.twoFactor);
    state.fail = {};
    await user.type(code, "123456");
    await user.click(save);
    await waitFor(() => {
      expect(saves().at(-1)?.body).toMatchObject({
        twoFactorCode: "123456",
        paramSource: "manual",
      });
    });
  });

  it("Edit is locked while a version is applying or the bot is changing state; the strip shows Applying v{n}…", async () => {
    state.pending = 2;
    const user = userEvent.setup();
    const b = one();
    wrap(
      <MainnetPanel
        sources={null}
        tz="UTC"
        modeSwitch={null}
        bots={[b]}
        botsLoading={false}
        botsError={null}
        selected={b}
        onBot={() => undefined}
        onHow={() => undefined}
        onStartFromVersion={() => undefined}
      />,
    );
    const strip = screen.getByRole("group", { name: M.strip.label });
    expect(await within(strip).findByText("Applying v2…")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: S.button }));
    const settings = await screen.findByRole("dialog", { name: b.name });
    await within(settings).findByText("Applying v2…");
    expect(within(settings).getByRole("button", { name: S.edit })).toBeDisabled();
    cleanup();
    state.pending = null;
    const pausing = one({ state: "pausing" });
    wrap(
      <MainnetPanel
        sources={null}
        tz="UTC"
        modeSwitch={null}
        bots={[pausing]}
        botsLoading={false}
        botsError={null}
        selected={pausing}
        onBot={() => undefined}
        onHow={() => undefined}
        onStartFromVersion={() => undefined}
      />,
    );
    await user.click(screen.getByRole("button", { name: S.button }));
    const s2 = await screen.findByRole("dialog", { name: pausing.name });
    await within(s2).findByText(/1×, isolated/);
    expect(within(s2).getByRole("button", { name: S.edit })).toBeDisabled();
  });
});
