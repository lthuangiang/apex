import {
  baselineVersionConfig,
  newsSignalConfigSchema,
  ReasonCode,
  SignalReason,
  Strategy,
  type NewsSignalConfig,
} from "@drift/shared";
import { describe, expect, it } from "vitest";

import { backtest, BacktestNotSupportedError, backtestSupported } from "../backtest";
import { clOrdId } from "../core/ids";
import type {
  NewsSignalInput,
  OrderIntent,
  StepContext,
  StrategyAction,
  StrategyEvent,
} from "../core/types";
import {
  closeTitle,
  initialNewsSignalState,
  NEWS_SIGNAL,
  newsSignal,
  newsTag,
  type NewsSignalState,
  type NewsTrade,
} from "../news-signal";
import { STRATEGIES } from "../registry";

// Bot `news_signal` mainnet (#419 PR 3, DEC-360): lọc riêng từng bot, lệnh vào IOC, TP/SL trên SoDEX, sửa TP/SL, max
// hold, tin ngược chiều, pause / resume / stop, SL bị từ chối, chỗ `unknown`, clOrdID tất định.

const T0 = Date.parse("2026-11-22T10:00:00Z");
const HOUR = 3_600_000;
const SOL = "SOL-USD";
const ctx: StepContext = {
  botId: "news-bot-1",
  version: 3,
  rules: {
    [SOL]: { tickSize: "0.01", stepSize: "0.01", minQuantity: "0.01", minNotional: "5" },
    "ETH-USD": { tickSize: "0.1", stepSize: "0.001", minQuantity: "0.001", minNotional: "5" },
  },
  feeRate: "0.0002",
  takerFeeRate: "0.0005",
};
const BOOK = { bid: "100", ask: "100.1" };

const cfg = (over: Partial<Record<string, unknown>> = {}): NewsSignalConfig =>
  newsSignalConfigSchema.parse({
    ...baselineVersionConfig(),
    sizeUsdc: "200",
    leverage: 1,
    ...over,
  });

let n = 0;
function sig(over: Partial<NewsSignalInput> = {}): NewsSignalInput {
  n += 1;
  return {
    id: `sig-${String(n)}`,
    storyKey: `${over.market ?? SOL}|${over.catalyst ?? "listing"}`,
    market: SOL,
    kind: "crypto",
    catalyst: "listing",
    side: "long",
    level: "high",
    firstPublishedAt: T0 - 60_000,
    collectedAt: T0 - 30_000,
    decidedAt: T0,
    expiresAt: T0 + 120_000,
    quote: { bid: "100", ask: "100.1", mid: "100.05", at: T0 },
    typicalByHoldHours: { "24": "3", "48": "4", "72": "5" },
    ...over,
  };
}

const signalEv = (
  s: NewsSignalInput,
  at = s.decidedAt + 1_000,
  extra: Partial<Extract<StrategyEvent, { type: "newsSignal" }>> = {},
): StrategyEvent => ({ type: "newsSignal", at, signal: s, book: BOOK, ...extra });

function run(
  c: NewsSignalConfig,
  s0: NewsSignalState,
  events: readonly StrategyEvent[],
): { state: NewsSignalState; actions: StrategyAction[] } {
  let state = s0;
  const actions: StrategyAction[] = [];
  for (const e of events) {
    const r = newsSignal.step(c, state, e, ctx);
    state = r.state;
    actions.push(...r.actions);
  }
  return { state, actions };
}

const places = (a: readonly StrategyAction[]): OrderIntent[] =>
  a.flatMap((x) => (x.type === "place" ? [x.order] : []));
const cancels = (a: readonly StrategyAction[]): string[] =>
  a.flatMap((x) => (x.type === "cancel" ? [x.clOrdID] : []));
const outcome = (a: readonly StrategyAction[]) => a.find((x) => x.type === "signalOutcome");
const results = (a: readonly StrategyAction[]) =>
  a.flatMap((x) => (x.type === "commandResult" ? [x] : []));
const trade = (s: NewsSignalState, id: string): NewsTrade => {
  const t = s.trades[id];
  if (t === undefined) throw new Error(`no trade ${id}`);
  return t;
};

const fill = (
  clOrdID: string,
  quantity: string,
  price = "100.2",
  at = T0 + 2_000,
): StrategyEvent => ({
  type: "fill",
  at,
  clOrdID,
  price,
  quantity,
  fee: "0.01",
});
const done = (clOrdID: string, at = T0 + 2_500): StrategyEvent => ({
  type: "orderDone",
  at,
  clOrdID,
});
const ack = (clOrdID: string, at = T0 + 3_000): StrategyEvent => ({
  type: "orderAck",
  at,
  clOrdID,
});
const reject = (clOrdID: string, code = "REJECTED", at = T0 + 3_000): StrategyEvent => ({
  type: "orderReject",
  at,
  clOrdID,
  code,
});

/** Một trade đã vào: lệnh vào khớp `qty` rồi kết thúc, TP/SL đã đặt. */
function opened(c = cfg(), qty = "1.99", s0 = initialNewsSignalState()) {
  const s = sig();
  const a = run(c, s0, [signalEv(s)]);
  const entry = places(a.actions)[0];
  if (entry === undefined) throw new Error("no entry");
  const b = run(c, a.state, [fill(entry.clOrdID, qty), done(entry.clOrdID)]);
  const t = trade(b.state, s.id);
  return { signal: s, entry, state: b.state, actions: [...a.actions, ...b.actions], trade: t };
}

describe("registry and backtest", () => {
  it("registers news_signal as a perps strategy with this module", () => {
    expect(STRATEGIES[Strategy.newsSignal].engines).toEqual(["perps"]);
    expect(STRATEGIES[Strategy.newsSignal].module).toBe(newsSignal);
  });

  it("refuses to backtest news_signal instead of returning a made-up result", () => {
    expect(backtestSupported(Strategy.newsSignal)).toBe(false);
    expect(backtestSupported(Strategy.spotGrid)).toBe(true);
    expect(() =>
      backtest(Strategy.newsSignal, cfg(), {
        markets: {},
        funding: {},
        fees: {
          spot: { maker: "0", taker: "0" },
          perps: { maker: "0", taker: "0" },
          builder: "0",
        },
        slippage: "0",
        intervalMs: 60_000,
      }),
    ).toThrow(BacktestNotSupportedError);
  });
});

describe("per-bot filter", () => {
  const dropReason = (c: NewsSignalConfig, s: NewsSignalState, e: StrategyEvent) => {
    const r = newsSignal.step(c, s, e, ctx);
    expect(places(r.actions)).toEqual([]);
    const o = outcome(r.actions);
    return o?.type === "signalOutcome" ? o.reason : undefined;
  };
  const s0 = initialNewsSignalState();

  it("drops while paused and does not catch up after Resume", () => {
    const paused = run(cfg(), s0, [{ type: "paused", at: T0 - 1 }]).state;
    expect(dropReason(cfg(), paused, signalEv(sig()))).toBe(SignalReason.botPaused);
    const resumed = run(cfg(), paused, [{ type: "resumed", at: T0 + 5_000, prices: {} }]).state;
    // Quyết định trước lúc Resume: đã lỡ, không vào bù.
    expect(dropReason(cfg(), resumed, signalEv(sig(), T0 + 6_000))).toBe(
      SignalReason.missedWhilePaused,
    );
    // Tín hiệu mới sau Resume: vào bình thường.
    const fresh = sig({ decidedAt: T0 + 10_000, expiresAt: T0 + 130_000 });
    const r = newsSignal.step(cfg(), resumed, signalEv(fresh), ctx);
    expect(places(r.actions)).toHaveLength(1);
  });

  it("applies the 120 s TTL (exactly 120 s is still on time)", () => {
    expect(dropReason(cfg(), s0, signalEv(sig(), T0 + 120_001))).toBe(SignalReason.signalStale);
    const r = newsSignal.step(cfg(), s0, signalEv(sig(), T0 + 120_000), ctx);
    expect(places(r.actions)).toHaveLength(1);
  });

  it("filters by news type, markets, level and source delay", () => {
    const off = cfg({
      news: { ...baselineVersionConfig().news, listing: { enabled: false, maxHoldHours: 24 } },
    });
    expect(dropReason(off, s0, signalEv(sig()))).toBe(SignalReason.newsTypeOff);
    const btcOnly = cfg({
      assets: { mode: "only", markets: ["BTC-USD"], crypto: true, stocks: true },
    });
    expect(dropReason(btcOnly, s0, signalEv(sig()))).toBe(SignalReason.assetNotInBot);
    expect(dropReason(cfg({ minLevel: "high" }), s0, signalEv(sig({ level: "medium" })))).toBe(
      SignalReason.levelTooLow,
    );
    expect(dropReason(cfg(), s0, signalEv(sig({ collectedAt: T0 - 60_000 + 31 * 60_000 })))).toBe(
      SignalReason.sourceLate,
    );
  });

  it("locks a story for 7 days once entered, and retries a skipped story only within 2 hours", () => {
    const o = opened();
    const again = sig({
      storyKey: o.signal.storyKey,
      decidedAt: T0 + 60_000,
      expiresAt: T0 + 180_000,
    });
    expect(dropReason(cfg(), o.state, signalEv(again))).toBe(SignalReason.sameStory);

    // Lần đầu bị bỏ vì giới hạn (story chưa vào lệnh), lần sau cùng story quá 2 giờ: STORY_TOO_OLD.
    const lim = cfg({ maxNewTradesPerDay: 1 });
    const first = run(lim, s0, [signalEv(sig({ market: "ETH-USD" }))]).state; // dùng hết lượt trong ngày
    const story = sig();
    const skipped = run(lim, first, [signalEv(story)]);
    expect(outcome(skipped.actions)).toMatchObject({ reason: SignalReason.limitDay });
    const late = T0 + 2 * HOUR + 5_000;
    const retry = sig({ storyKey: story.storyKey, decidedAt: late, expiresAt: late + 120_000 });
    expect(dropReason(lim, skipped.state, signalEv(retry))).toBe(SignalReason.storyTooOld);
  });

  it("drops a second trade on the same market, a busy account × market and the limits", () => {
    const o = opened();
    const other = sig({ catalyst: "treasury_buy" });
    expect(dropReason(cfg(), o.state, signalEv(other))).toBe(SignalReason.tradeOpen);
    expect(dropReason(cfg(), s0, signalEv(sig(), undefined, { accountMarketBusy: true }))).toBe(
      SignalReason.accountMarketBusy,
    );
    expect(
      dropReason(cfg({ maxOpenTrades: 1 }), o.state, signalEv(sig({ market: "ETH-USD" }))),
    ).toBe(SignalReason.limitOpen);
  });

  it("needs typical move, a live book, enough move for the cost and SoDEX min size", () => {
    expect(dropReason(cfg(), s0, signalEv(sig({ typicalByHoldHours: { "24": null } })))).toBe(
      SignalReason.notEnoughHistory,
    );
    expect(dropReason(cfg(), s0, signalEv(sig(), undefined, { book: null }))).toBe(
      SignalReason.noBookData,
    );
    expect(dropReason(cfg(), s0, signalEv(sig({ typicalByHoldHours: { "24": "0.05" } })))).toBe(
      SignalReason.moveTooSmall,
    );
    const wide = { bid: "100", ask: "100.5" };
    expect(
      dropReason(
        cfg(),
        s0,
        signalEv(sig({ typicalByHoldHours: { "24": "0.2" } }), undefined, { book: wide }),
      ),
    ).toBe(SignalReason.tooThin);
    expect(dropReason(cfg({ sizeUsdc: "1" }), s0, signalEv(sig()))).toBe(SignalReason.belowMinSize);
  });

  it("never acts twice on the same signal", () => {
    const s = sig();
    const a = run(cfg(), s0, [signalEv(s)]);
    expect(places(a.actions)).toHaveLength(1);
    const b = newsSignal.step(cfg(), a.state, signalEv(s, T0 + 5_000), ctx);
    expect(b.actions).toEqual([]);
    expect(b.state).toBe(a.state);
  });
});

describe("entry", () => {
  it("sends a limit IOC at the price cap, sized within 200 USDC, with a deterministic clOrdID", () => {
    const s = sig();
    const r = newsSignal.step(cfg(), initialNewsSignalState(), signalEv(s), ctx);
    expect(outcome(r.actions)).toMatchObject({ outcome: "accepted" });
    const [o] = places(r.actions);
    // mid 100.05 + (0.05 + 0.2% × 100.05) = 100.3001 → tick xuống 100.30; 200 / 100.30 → 1.99.
    expect(o).toMatchObject({
      type: "limit",
      timeInForce: "IOC",
      side: "buy",
      price: "100.3",
      quantity: "1.99",
      reduceOnly: false,
      tag: `ns:${s.id}:entry`,
      clOrdID: clOrdId(ctx.botId, 1, `ns:${s.id}:entry`, 0),
    });
  });

  it("caps the size at 200 USDC even if the config says more", () => {
    const raw = { ...cfg(), sizeUsdc: "500" };
    const [o] = places(
      newsSignal.step(raw, initialNewsSignalState(), signalEv(sig()), ctx).actions,
    );
    expect(Number(o?.price) * Number(o?.quantity)).toBeLessThanOrEqual(200);
    expect(o?.quantity).toBe("1.99");
  });

  it("an entry the engine blocked before sending records the block code, not ENTRY_NOT_FILLED, and never says SoDEX rejected it (#419 B1)", () => {
    for (const code of [
      "NEWS_ORDER_INVALID",
      "NEWS_CAP_EXCEEDED",
      "NEWS_ACCESS_OFF",
      "BOT_NOT_RUNNING",
      "LEVERAGE_NOT_SET",
    ]) {
      const s = sig();
      const a = run(cfg(), initialNewsSignalState(), [signalEv(s)]);
      const entry = places(a.actions)[0]?.clOrdID ?? "";
      const b = run(cfg(), a.state, [reject(entry, code)]);
      expect(b.state.trades[s.id]).toMatchObject({ status: "closed", closeReason: code });
      const why = b.actions.find((x) => x.type === "log");
      expect(why).toMatchObject({ decision: "Entry rejected" });
      expect(JSON.stringify(why)).toContain("DeskLabs did not send the entry");
    }
    // Từ chối thật của SoDEX vẫn là ENTRY_NOT_FILLED.
    const s = sig();
    const a = run(cfg(), initialNewsSignalState(), [signalEv(s)]);
    const b = run(cfg(), a.state, [reject(places(a.actions)[0]?.clOrdID ?? "", "-1")]);
    expect(b.state.trades[s.id]?.closeReason).toBe(SignalReason.entryNotFilled);
  });

  it("records ENTRY_NOT_FILLED when the IOC fills nothing, and the story is not locked", () => {
    const s = sig();
    const a = run(cfg(), initialNewsSignalState(), [signalEv(s)]);
    const entry = places(a.actions)[0]?.clOrdID ?? "";
    const b = run(cfg(), a.state, [done(entry)]);
    expect(places(b.actions)).toEqual([]);
    // Lệnh đã đóng còn trong state ở bước đóng nó (engine ghi trạng thái cuối, #419 engine A).
    expect(b.state.trades[s.id]).toMatchObject({
      status: "closed",
      closeReason: SignalReason.entryNotFilled,
    });
    expect(b.state.orders).toEqual({});
    const retry = sig({ storyKey: s.storyKey, decidedAt: T0 + 60_000, expiresAt: T0 + 180_000 });
    expect(places(newsSignal.step(cfg(), b.state, signalEv(retry), ctx).actions)).toHaveLength(1);
  });

  it("places SL (native stop, whole position) and TP (reduce-only GTC) for the filled part only", () => {
    const o = opened(cfg(), "1.2");
    const [sl, tp] = places(o.actions).slice(1);
    expect(sl).toMatchObject({
      type: "market",
      reduceOnly: true,
      quantity: "1.2",
      tag: newsTag.sl(o.signal.id, 0),
    });
    // Giá vào 100.2: SL = 100.2 × (1 − 2.25%) = 97.9455 → tick lên 97.95; TP = 100.2 × 1.045 = 104.709 → 104.70.
    expect(sl?.stop).toEqual({ price: "97.95" });
    expect(sl?.tag.endsWith(":sl")).toBe(true);
    expect(tp).toMatchObject({
      type: "limit",
      timeInForce: "GTC",
      reduceOnly: true,
      quantity: "1.2",
      price: "104.7",
      side: "sell",
    });
    expect(o.trade.status).toBe("open");
  });

  it("re-sizes the TP on a late entry fill: new TP first, old TP cancelled after the ack", () => {
    const o = opened(cfg(), "1.2");
    const oldTp = o.trade.tp?.id ?? "";
    const late = run(cfg(), o.state, [fill(o.entry.clOrdID, "0.79", "100.2", T0 + 10_000)]);
    const [newTp] = places(late.actions);
    expect(newTp).toMatchObject({
      quantity: "1.99",
      tag: newsTag.tp(o.signal.id, 1),
      price: "104.7",
    });
    expect(cancels(late.actions)).toEqual([]);
    const acked = run(cfg(), late.state, [ack(newTp?.clOrdID ?? "")]);
    expect(cancels(acked.actions)).toEqual([oldTp]);
    expect(trade(acked.state, o.signal.id).tp?.id).toBe(newTp?.clOrdID);
  });
});

describe("TP / SL", () => {
  it("is OCO: a full TP fill closes the trade and cancels the SL", () => {
    const o = opened();
    const r = run(cfg(), o.state, [fill(o.trade.tp?.id ?? "", "1.99", "104.7", T0 + HOUR)]);
    expect(cancels(r.actions)).toEqual([o.trade.sl?.id]);
    const t = trade(r.state, o.signal.id);
    expect(t).toMatchObject({ status: "closed", closeReason: SignalReason.takeProfit });
    // Hết lệnh chờ: lệnh đóng còn trong state (engine ghi trạng thái cuối), bỏ sau `closedKeepMs` ở tín hiệu kế tiếp.
    const end = run(cfg(), r.state, [done(o.trade.sl?.id ?? ""), done(o.trade.tp?.id ?? "")]);
    expect(end.state.trades[o.signal.id]?.status).toBe("closed");
    expect(end.state.orders).toEqual({});
    const later = T0 + HOUR + NEWS_SIGNAL.closedKeepMs + 1;
    const next = sig({ market: "ETH-USD", decidedAt: later, expiresAt: later + 120_000 });
    const pruned = run(cfg(), end.state, [signalEv(next)]);
    expect(pruned.state.trades[o.signal.id]).toBeUndefined();
  });

  it("a stop loss fill cancels the TP; a partial TP fill keeps the SL", () => {
    const o = opened();
    const part = run(cfg(), o.state, [fill(o.trade.tp?.id ?? "", "0.5", "104.7")]);
    expect(cancels(part.actions)).toEqual([]);
    const r = run(cfg(), part.state, [fill(o.trade.sl?.id ?? "", "1.49", "97.9")]);
    expect(cancels(r.actions)).toEqual([o.trade.tp?.id]);
    expect(trade(r.state, o.signal.id).closeReason).toBe(SignalReason.stopLoss);
  });

  it("SL rejected after the entry filled: closes at market and pauses ORDER_REJECTED", () => {
    const o = opened();
    const r = run(cfg(), o.state, [reject(o.trade.sl?.id ?? "", "INVALID_STOP")]);
    const [close] = places(r.actions);
    expect(close).toMatchObject({
      type: "market",
      reduceOnly: true,
      quantity: "1.99",
      side: "sell",
    });
    expect(r.actions).toContainEqual({ type: "pause", reason: ReasonCode.orderRejected });
    expect(r.state.paused).toBe(true);
    const flat = run(cfg(), r.state, [fill(close?.clOrdID ?? "", "1.99", "100")]);
    expect(cancels(flat.actions)).toEqual([o.trade.tp?.id]);
    expect(trade(flat.state, o.signal.id).closeReason).toBe("SL_REJECTED");
  });

  it("a rejected TP is not retried blindly: SL and max hold stay, Needs attention", () => {
    const o = opened();
    const r = run(cfg(), o.state, [reject(o.trade.tp?.id ?? "")]);
    expect(places(r.actions)).toEqual([]);
    expect(r.actions).toContainEqual({ type: "flag", needsAttention: true });
    expect(trade(r.state, o.signal.id).sl?.id).toBe(o.trade.sl?.id);
  });
});

describe("Edit TP/SL", () => {
  const edit = (
    signalId: string,
    tp: string | null,
    sl: string | null,
    seq = 1,
    id = `cmd-${String(seq)}`,
  ): StrategyEvent => ({
    type: "newsCommand",
    at: T0 + HOUR,
    command: { id, signalId, kind: "edit_tpsl", seq, tp, sl },
  });

  it("places the new orders, waits for every ack, then cancels the old ones", () => {
    const o = opened();
    const r = run(cfg(), o.state, [edit(o.signal.id, "106", "99")]);
    const [tp, sl] = places(r.actions);
    expect(tp).toMatchObject({ price: "106", tag: newsTag.tp(o.signal.id, 1), quantity: "1.99" });
    expect(sl?.stop).toEqual({ price: "99" });
    expect(cancels(r.actions)).toEqual([]);
    const one = run(cfg(), r.state, [ack(tp?.clOrdID ?? "")]);
    expect(cancels(one.actions)).toEqual([]);
    expect(results(one.actions)).toEqual([]);
    const both = run(cfg(), one.state, [ack(sl?.clOrdID ?? "")]);
    expect(cancels(both.actions).sort()).toEqual([o.trade.tp?.id, o.trade.sl?.id].sort());
    expect(results(both.actions)).toEqual([
      { type: "commandResult", commandId: "cmd-1", status: "applied" },
    ]);
    const t = trade(both.state, o.signal.id);
    expect(t).toMatchObject({ tpslSeq: 1, tp: { price: "106" }, sl: { price: "99" } });
  });

  it("keeps the old orders when SoDEX rejects a new one, cancelling the new leg it accepted", () => {
    const o = opened();
    const r = run(cfg(), o.state, [edit(o.signal.id, "106", "99")]);
    const [tp, sl] = places(r.actions);
    const x = run(cfg(), r.state, [ack(tp?.clOrdID ?? ""), reject(sl?.clOrdID ?? "", "BAD_STOP")]);
    expect(cancels(x.actions)).toEqual([tp?.clOrdID]);
    expect(results(x.actions)).toEqual([
      { type: "commandResult", commandId: "cmd-1", status: "rejected", code: "BAD_STOP" },
    ]);
    const t = trade(x.state, o.signal.id);
    expect(t.tp?.id).toBe(o.trade.tp?.id);
    expect(t.sl?.id).toBe(o.trade.sl?.id);
    expect(t.pending).toBeNull();
  });

  it("waits on an unknown new order: no second edit, and NOT_PLACED after the check rejects the command", () => {
    const o = opened();
    const r = run(cfg(), o.state, [edit(o.signal.id, "106", null)]);
    const [tp] = places(r.actions);
    // Không có ack / reject (lệnh `unknown`): lần sửa sau bị từ chối, không đặt chồng.
    const second = run(cfg(), r.state, [edit(o.signal.id, "107", null, 2)]);
    expect(places(second.actions)).toEqual([]);
    expect(results(second.actions)).toEqual([
      { type: "commandResult", commandId: "cmd-2", status: "rejected", code: "EDIT_IN_PROGRESS" },
    ]);
    const checked = run(cfg(), second.state, [reject(tp?.clOrdID ?? "", "NOT_PLACED")]);
    expect(results(checked.actions)).toEqual([
      { type: "commandResult", commandId: "cmd-1", status: "rejected", code: "NOT_PLACED" },
    ]);
    expect(trade(checked.state, o.signal.id).tp?.id).toBe(o.trade.tp?.id);
  });

  it("rejects bad prices, a trade that is not open, and applies a no-op edit at once", () => {
    const o = opened();
    expect(results(run(cfg(), o.state, [edit(o.signal.id, "95", null)]).actions)[0]).toMatchObject({
      status: "rejected",
      code: "INVALID_PRICE",
    });
    expect(results(run(cfg(), o.state, [edit("nope", "106", null)]).actions)[0]).toMatchObject({
      code: "TRADE_CLOSED",
    });
    const s = sig({ market: "ETH-USD", storyKey: "ETH-USD|listing" });
    const entering = run(cfg(), o.state, [signalEv(s)]).state;
    expect(results(run(cfg(), entering, [edit(s.id, "106", null)]).actions)[0]).toMatchObject({
      code: "TRADE_NOT_OPEN",
    });
    const same = run(cfg(), o.state, [edit(o.signal.id, o.trade.tp?.price ?? "", null)]);
    expect(places(same.actions)).toEqual([]);
    expect(results(same.actions)[0]).toMatchObject({ status: "applied" });
  });
});

describe("closing", () => {
  it("max hold: market IOC reduce-only first, TP/SL cancelled only once flat", () => {
    const o = opened();
    expect(run(cfg(), o.state, [{ type: "timer", at: o.trade.maxHoldUntil - 1 }]).actions).toEqual(
      [],
    );
    const r = run(cfg(), o.state, [{ type: "timer", at: o.trade.maxHoldUntil }]);
    const [hold] = places(r.actions);
    expect(hold).toMatchObject({
      type: "market",
      timeInForce: "IOC",
      reduceOnly: true,
      quantity: "1.99",
      tag: `ns:${o.signal.id}:hold`,
    });
    expect(cancels(r.actions)).toEqual([]);
    // Lệnh đóng đang chạy (chưa có kết quả): nhịp sau không gửi lệnh đóng thứ hai.
    expect(
      places(run(cfg(), r.state, [{ type: "timer", at: o.trade.maxHoldUntil + 5_000 }]).actions),
    ).toEqual([]);
    const flat = run(cfg(), r.state, [fill(hold?.clOrdID ?? "", "1.99", "101")]);
    expect(cancels(flat.actions).sort()).toEqual([o.trade.tp?.id, o.trade.sl?.id].sort());
    expect(trade(flat.state, o.signal.id).closeReason).toBe(SignalReason.maxHold);
  });

  it("re-sends the rest after a partial close and gives up after 3 rejections", () => {
    const o = opened();
    const r = run(cfg(), o.state, [{ type: "timer", at: o.trade.maxHoldUntil }]);
    const hold = places(r.actions)[0]?.clOrdID ?? "";
    const part = run(cfg(), r.state, [fill(hold, "1", "101"), done(hold)]);
    const [rest] = places(part.actions);
    expect(rest).toMatchObject({ quantity: "0.99", tag: `ns:${o.signal.id}:hold:1` });
    let st = part.state;
    let id = rest?.clOrdID ?? "";
    const ids = [id];
    for (let i = 0; i < 3; i += 1) {
      const x = run(cfg(), st, [reject(id, "REJECTED")]);
      st = x.state;
      id = places(x.actions)[0]?.clOrdID ?? "";
      if (i < 2) {
        expect(id).toBe(clOrdId(ctx.botId, 1, `ns:${o.signal.id}:hold:1`, i + 1));
        ids.push(id);
      } else {
        expect(id).toBe("");
        expect(x.actions).toContainEqual({ type: "flag", needsAttention: true });
      }
    }
    const t = trade(st, o.signal.id);
    expect(t).toMatchObject({ status: "open", close: null, holdGaveUp: true });
    expect(
      places(run(cfg(), st, [{ type: "timer", at: o.trade.maxHoldUntil + HOUR }]).actions),
    ).toEqual([]);
  });

  it("max hold still applies while paused", () => {
    const o = opened();
    const r = run(cfg(), o.state, [
      { type: "paused", at: T0 + HOUR },
      { type: "timer", at: o.trade.maxHoldUntil },
    ]);
    expect(places(r.actions)).toHaveLength(1);
  });

  it("Close now: market close, applied once flat; a second close while one runs is refused", () => {
    const o = opened();
    const cmd = (id: string, seq: number): StrategyEvent => ({
      type: "newsCommand",
      at: T0 + HOUR,
      command: { id, signalId: o.signal.id, kind: "close", seq, tp: null, sl: null },
    });
    const r = run(cfg(), o.state, [cmd("c1", 4)]);
    const [close] = places(r.actions);
    expect(close?.tag).toBe(`ns:${o.signal.id}:close:4`);
    expect(results(r.actions)).toEqual([]);
    expect(results(run(cfg(), r.state, [cmd("c2", 5)]).actions)).toEqual([
      { type: "commandResult", commandId: "c2", status: "rejected", code: "CLOSE_IN_PROGRESS" },
    ]);
    const flat = run(cfg(), r.state, [fill(close?.clOrdID ?? "", "1.99", "101")]);
    expect(results(flat.actions)).toEqual([
      { type: "commandResult", commandId: "c1", status: "applied" },
    ]);
    expect(cancels(flat.actions).sort()).toEqual([o.trade.tp?.id, o.trade.sl?.id].sort());
  });

  it("opposite news: Keep leaves the trade, Close closes it, never flips", () => {
    const o = opened();
    const opp = sig({ catalyst: "hack_exploit", side: "short", storyKey: `${SOL}|hack_exploit` });
    const keep = run(cfg(), o.state, [signalEv(opp)]);
    expect(places(keep.actions)).toEqual([]);
    expect(outcome(keep.actions)).toMatchObject({
      outcome: "dropped",
      reason: SignalReason.tradeOpen,
    });

    const closeCfg = cfg({ onOppositeNews: "close" });
    const close = run(closeCfg, o.state, [signalEv(opp)]);
    const orders = places(close.actions);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ reduceOnly: true, side: "sell", type: "market" });
    const flat = run(closeCfg, close.state, [fill(orders[0]?.clOrdID ?? "", "1.99", "99")]);
    expect(places(flat.actions)).toEqual([]);
    expect(trade(flat.state, o.signal.id).closeReason).toBe(SignalReason.oppositeNews);
  });
});

describe("Stop", () => {
  it("Keep open trades: nothing cancelled, TP/SL listed for the engine to keep, no max hold after", () => {
    const o = opened();
    const r = run(cfg(), o.state, [{ type: "newsStop", at: T0 + HOUR, close: false }]);
    expect(r.actions).toEqual([]);
    expect([...(newsSignal.keepOnStop?.(r.state) ?? [])].sort()).toEqual(
      [o.trade.tp?.id, o.trade.sl?.id].sort(),
    );
    expect(
      places(run(cfg(), r.state, [{ type: "timer", at: o.trade.maxHoldUntil + 1 }]).actions),
    ).toEqual([]);
    expect(
      outcome(run(cfg(), r.state, [signalEv(sig({ market: "ETH-USD" }))]).actions),
    ).toMatchObject({
      reason: SignalReason.botPaused,
    });
  });

  it("Close all now: closes each open trade at market, then cancels TP/SL", () => {
    const o = opened();
    const r = run(cfg(), o.state, [{ type: "newsStop", at: T0 + HOUR, close: true }]);
    const [close] = places(r.actions);
    expect(close).toMatchObject({
      tag: `ns:${o.signal.id}:stop`,
      reduceOnly: true,
      quantity: "1.99",
    });
    expect(cancels(r.actions)).toEqual([]);
    const flat = run(cfg(), r.state, [fill(close?.clOrdID ?? "", "1.99", "100")]);
    expect(cancels(flat.actions).sort()).toEqual([o.trade.tp?.id, o.trade.sl?.id].sort());
  });

  it("Close all now with an entry still running: closes it as soon as the entry ends, no TP/SL", () => {
    const s = sig();
    const a = run(cfg(), initialNewsSignalState(), [signalEv(s)]);
    const entry = places(a.actions)[0]?.clOrdID ?? "";
    const b = run(cfg(), a.state, [
      { type: "newsStop", at: T0 + 1_500, close: true },
      fill(entry, "1.99"),
      done(entry),
    ]);
    const orders = places(b.actions);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ tag: `ns:${s.id}:stop`, reduceOnly: true });
  });
});

describe("unknown slots and deterministic ids", () => {
  it("an entry with no result yet places no TP/SL and blocks the market", () => {
    const s = sig();
    const a = run(cfg(), initialNewsSignalState(), [
      signalEv(s),
      { type: "timer", at: T0 + 60_000 },
    ]);
    expect(places(a.actions)).toHaveLength(1);
    expect(trade(a.state, s.id).status).toBe("entering");
    expect(newsSignal.awaitsEnd?.(a.state, places(a.actions)[0]?.clOrdID ?? "")).toBe(true);
    const other = sig({ catalyst: "treasury_buy", storyKey: `${SOL}|treasury_buy` });
    expect(outcome(run(cfg(), a.state, [signalEv(other)]).actions)).toMatchObject({
      reason: SignalReason.tradeOpen,
    });
  });

  it("rebuilds the same clOrdIDs from saved state after a restart", () => {
    const o = opened();
    const saved = JSON.parse(JSON.stringify(o.state)) as NewsSignalState;
    const events: StrategyEvent[] = [
      {
        type: "newsCommand",
        at: T0 + HOUR,
        command: { id: "c", signalId: o.signal.id, kind: "edit_tpsl", seq: 1, tp: "106", sl: null },
      },
      { type: "timer", at: o.trade.maxHoldUntil },
    ];
    const live = run(cfg(), o.state, events);
    const restarted = run(cfg(), saved, events);
    expect(places(restarted.actions)).toEqual(places(live.actions));
    expect(places(live.actions).map((p) => p.clOrdID)).toEqual([
      clOrdId(ctx.botId, 1, newsTag.tp(o.signal.id, 1)),
      clOrdId(ctx.botId, 1, `ns:${o.signal.id}:hold`),
    ]);
    // Không phụ thuộc version của bot.
    const v9 = { ...ctx, version: 9 };
    const timer: StrategyEvent = { type: "timer", at: o.trade.maxHoldUntil };
    expect(newsSignal.step(cfg(), saved, timer, v9).actions).toEqual(
      newsSignal.step(cfg(), saved, timer, ctx).actions,
    );
  });

  it("Start again after Stop (engine sends resumed) clears the stop mark, so later signals trade; kept trades keep max hold off (#469)", () => {
    const o = opened();
    const stopped = run(cfg(), o.state, [{ type: "newsStop", at: T0 + HOUR, close: false }]);
    expect(stopped.state.stopping).toBe("keep");
    const blocked = run(cfg(), stopped.state, [
      signalEv(sig({ market: "ETH-USD" }), T0 + HOUR + 1),
    ]);
    expect(outcome(blocked.actions)).toMatchObject({ outcome: "dropped" });
    const at = T0 + 2 * HOUR;
    const started = run(cfg(), stopped.state, [{ type: "resumed", at, prices: {} }]);
    expect(started.state.stopping).toBeNull();
    expect(trade(started.state, o.signal.id).maxHoldOff).toBe(true);
    const later = sig({ market: "ETH-USD", decidedAt: at + 1_000, expiresAt: at + 120_000 });
    const next = run(cfg(), started.state, [signalEv(later)]);
    expect(places(next.actions).map((p) => p.tag)).toEqual([newsTag.entry(later.id)]);
  });

  it("applies a new version while a trade is open and keeps the state as is (#469)", () => {
    const o = opened(cfg({ leverage: 10 }));
    expect(newsSignal.applyVersion?.(cfg({ leverage: 5 }), o.state, ctx)).toBe(o.state);
    const empty = initialNewsSignalState();
    expect(newsSignal.applyVersion?.(cfg(), empty, ctx)).toBe(empty);
  });

  it("keeps the open trade's TP, SL, max hold and leverage; later signals use the new config (#469)", () => {
    const v1 = cfg({ leverage: 10, sizeUsdc: "200" });
    const v2 = cfg({ leverage: 5, sizeUsdc: "100", tpMultiple: "3", slMultiple: "0.5" });
    const o = opened(v1);
    expect(o.trade.leverage).toBe(10);
    const applied = newsSignal.applyVersion?.(v2, o.state, ctx);
    if (applied === null || applied === undefined) throw new Error("not applied");
    const kept = trade(applied, o.signal.id);
    expect(kept).toEqual(o.trade);
    // Ack TP / SL dưới v2: không gửi lại, không huỷ gì.
    const tpId = o.trade.tp?.id ?? "";
    const slId = o.trade.sl?.id ?? "";
    const acked = run(v2, applied, [ack(tpId), ack(slId)]);
    expect(places(acked.actions)).toEqual([]);
    expect(cancels(acked.actions)).toEqual([]);
    // Max hold vẫn theo lúc vào, đóng cả khối lượng của lệnh cũ (không theo size mới).
    const hold = run(v2, acked.state, [{ type: "timer", at: o.trade.maxHoldUntil }]);
    const close = places(hold.actions).find((p) => p.reduceOnly && p.type === "market");
    expect(close?.quantity).toBe("1.99");
    // Tín hiệu sau ở market khác: size, đòn bẩy, TP / SL của v2.
    const eth = sig({ market: "ETH-USD", storyKey: "ETH-USD|listing" });
    const next = run(v2, acked.state, [signalEv(eth)]);
    const fresh = trade(next.state, eth.id);
    expect(fresh.leverage).toBe(5);
    expect(fresh.sizeUsdc).toBe("100");
    expect(fresh.tpPct).toBe("9");
    expect(fresh.slPct).toBe("1.5");
    expect(trade(next.state, o.signal.id)).toEqual(o.trade);
  });
});

describe("Decisions titles when a trade closes (#419 B2, PM approved)", () => {
  it("always name the reason", () => {
    expect(
      [
        SignalReason.takeProfit,
        SignalReason.stopLoss,
        SignalReason.maxHold,
        SignalReason.oppositeNews,
        "STOP",
        "SL_REJECTED",
        "MANUAL",
      ].map(closeTitle),
    ).toEqual([
      "Closed: take profit",
      "Closed: stop loss",
      "Closed: max hold",
      "Closed: opposite news",
      "Closed: bot stopped",
      "Closed: stop loss rejected",
      "Closed by you",
    ]);
  });

  it("a reason without its own title is just Closed, never Closed by you (PM review #448)", () => {
    expect(closeTitle("SOMETHING_NEW")).toBe("Closed");
    expect(closeTitle("MANUAL")).toBe("Closed by you");
  });
});

describe("leverage and the liquidation check (#458)", () => {
  const tiered: StepContext = {
    ...ctx,
    rules: {
      ...ctx.rules,
      [SOL]: {
        ...(ctx.rules[SOL] ?? {
          tickSize: "0.01",
          stepSize: "0.01",
          minQuantity: "0.01",
          minNotional: "5",
        }),
        maxLeverage: 20,
        marginTiers: [
          {
            maxNotionalValue: "4000000",
            maintenanceMarginRate: "0.005",
            maxLeverage: 40,
            maintenanceDeduction: "0",
          },
        ],
      },
    },
  };
  const wide = { "24": "10", "48": "10", "72": "10" };

  it("drops a signal whose stop loss would sit beyond the estimated liquidation at the bot's leverage", () => {
    const s = sig({ typicalByHoldHours: wide });
    const r = newsSignal.step(cfg({ leverage: 20 }), initialNewsSignalState(), signalEv(s), tiered);
    expect(places(r.actions)).toEqual([]);
    expect(outcome(r.actions)).toMatchObject({
      outcome: "dropped",
      reason: SignalReason.slBeyondLiquidation,
      detail: { leverage: 20 },
    });
  });

  it("1× never runs the check; at 20× the entry size stays capped at 200 USDC", () => {
    const s = sig({ typicalByHoldHours: wide });
    const one = newsSignal.step(
      cfg({ leverage: 1 }),
      initialNewsSignalState(),
      signalEv(s),
      tiered,
    );
    expect(places(one.actions)).toHaveLength(1);
    // Stop loss gần (typical nhỏ): 20× được vào, cùng khối lượng với 1× (giá trị vị thế ≤ 200, không nhân đòn bẩy).
    const tight = sig({ typicalByHoldHours: { "24": "1", "48": "1", "72": "1" } });
    const at20 = newsSignal.step(
      cfg({ leverage: 20 }),
      initialNewsSignalState(),
      signalEv(tight),
      tiered,
    );
    const at1 = newsSignal.step(
      cfg({ leverage: 1 }),
      initialNewsSignalState(),
      signalEv(tight),
      tiered,
    );
    const [o20] = places(at20.actions);
    const [o1] = places(at1.actions);
    expect(o20).toBeDefined();
    expect(o1).toBeDefined();
    expect(o20?.quantity).toBe(o1?.quantity);
    expect(Number(o20?.price) * Number(o20?.quantity)).toBeLessThanOrEqual(200);
  });
});
