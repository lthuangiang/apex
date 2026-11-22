import {
  assetAllowed,
  costCheck,
  dec,
  Decimal,
  isNewsEntryBlock,
  levelAtLeast,
  NEWS_RULES,
  NEWS_SIGNAL_LIVE_MAX_USDC,
  newsEntryLimitPrice,
  newsSignalStale,
  ReasonCode,
  RoundMode,
  roundTripCost,
  SignalReason,
  storyTooOld,
  versionHoldHours,
  type NewsSignalConfig,
  type SignalCatalyst,
} from "@drift/shared";

import { clOrdId } from "../core/ids";
import { applyFill, emptyLedger, type Ledger } from "../core/ledger";
import { meetsMinimum, priceText, roundPrice, roundQty } from "../core/rounding";
import type {
  NewsCommandInput,
  NewsSignalInput,
  OrderIntent,
  StepContext,
  StepResult,
  StrategyAction,
  StrategyEvent,
  StrategyModule,
} from "../core/types";

// Bot `news_signal` trên SoDEX mainnet (#419, DEC-360). Hàm thuần, không I/O: engine giao tín hiệu dùng chung
// (`newsSignal`), lệnh của người dùng (`newsCommand`), Stop (`newsStop`), pause (`paused`) / `resumed`, cùng fill / ack /
// kết thúc lệnh như mọi chiến lược.
//
// Mỗi tín hiệu được lọc riêng cho bot này (loại tin, Markets, Min level, nguồn trễ, story 7 ngày / thử lại 2 giờ, giới
// hạn, giá, chi phí, trần 200 USDC); bị loại thì trả `signalOutcome` kèm `SignalReason`. Vào lệnh: limit IOC tại giá trần
// `newsEntryLimitPrice`. Lệnh vào kết thúc mà có khớp: SL là stop gốc SoDEX (reduce-only, đóng cả vị thế), TP là limit
// reduce-only GTC theo phần đã khớp. Sửa TP/SL: đặt lệnh mới, chờ `orderAck` rồi mới huỷ lệnh cũ. Đóng (max hold, Close
// now, tin ngược chiều, Stop Close all, SL bị từ chối): market IOC reduce-only, khi vị thế về 0 mới huỷ TP/SL.
//
// clOrdID: `clOrdId(botId, seq, tag, attempt)` với `seq` = số thứ tự lệnh news của bot (không theo version bot), tag
// `ns:<signalId>:…`. Mọi id dựng lại được từ state (restart, đổi shard ra đúng id cũ). `attempt` chỉ tăng khi lệnh bị
// từ chối rõ ràng (kể cả `NOT_PLACED` sau đối soát). Lệnh chưa có kết quả (`unknown`) giữ chỗ: không đặt lệnh thay thế
// cho chỗ đó tới khi engine báo kết quả đối soát (quy tắc 1.7).

export const NEWS_SIGNAL = {
  /** Lệnh đóng bị từ chối quá ngần này lần thì thôi, bật Needs attention (TP/SL vẫn trên SoDEX). */
  maxCloseAttempts: 3,
  /** Giữ id tín hiệu đã thấy thêm ngần này sau `expires_at` (chống giao trùng). */
  seenKeepMs: 60 * 60_000,
  /**
   * Lệnh đã đóng (không còn lệnh SoDEX nào đang chờ) ở lại state ngần này sau `closedAt` rồi mới bỏ (#419 engine A): engine
   * ghi `news_signal_trades` theo `newsTrades()`, nên phải thấy được trạng thái `closed` (kèm lý do) ít nhất một lần, kể cả
   * khi lệnh đóng và hết lệnh chờ trong cùng một bước (lệnh vào IOC không khớp gì).
   */
  closedKeepMs: 24 * 60 * 60_000,
} as const;

const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
const STORY_LOCK_MS = NEWS_RULES.storyWindowDays * DAY_MS;

type Role = "entry" | "tp" | "sl" | "close";
type CloseKind = "hold" | "command" | "stop" | "opposite" | "sl_rejected";

export interface NewsLeg {
  id: string;
  price: string;
  /** Khối lượng của lệnh (SL: chỉ để ghi sổ, SoDEX đóng cả vị thế). */
  qty: string;
}

/** Lệnh TP/SL mới đang chờ SoDEX xác nhận (Edit TP/SL, hoặc TP theo khối lượng mới khi lệnh vào khớp muộn). */
export interface NewsPendingEdit {
  seq: number;
  commandId: string | null;
  tp: (NewsLeg & { acked: boolean }) | null;
  sl: (NewsLeg & { acked: boolean }) | null;
  /** Một chân bị từ chối: chờ các chân còn lại kết thúc rồi báo `rejected`. */
  failed: string | null;
}

export interface NewsClose {
  kind: CloseKind;
  id: string;
  tag: string;
  attempt: number;
  /** Lần gửi lại sau khi lệnh trước kết thúc mà vị thế còn (khớp một phần). */
  round: number;
  commandId: string | null;
  /** `SignalReason` ghi vào `close_reason` khi vị thế về 0. */
  reason: string;
}

export interface NewsTrade {
  signalId: string;
  storyKey: string;
  seq: number;
  market: string;
  side: "long" | "short";
  /** `entering`: lệnh vào đang chạy; `open`; `closing`: lệnh đóng đang chạy; `closed`. */
  status: "entering" | "open" | "closing" | "closed";
  sizeUsdc: string;
  entryId: string;
  entryAttempt: number;
  entryLimit: string;
  entryDone: boolean;
  /** Khối lượng lệnh vào đã khớp và tổng giá trị (để tính giá vào trung bình). */
  filled: string;
  filledNotional: string;
  /** Khối lượng đã đóng (TP, SL, lệnh đóng). */
  exited: string;
  tpPct: string;
  slPct: string;
  tp: NewsLeg | null;
  sl: NewsLeg | null;
  tpslSeq: number;
  pending: NewsPendingEdit | null;
  /** Lệnh vào khớp thêm khi TP đang chờ xác nhận: đặt lại TP theo khối lượng mới khi chỗ trống. */
  resizeOwed: boolean;
  /** Lệnh cũ đã gửi huỷ (sửa TP/SL, hoặc đã đóng xong), chờ SoDEX báo kết thúc; fill muộn vẫn vào sổ. */
  retiring: string[];
  close: NewsClose | null;
  openedAt: number;
  maxHoldUntil: number;
  /** Stop "Keep open trades": thôi áp max hold, chỉ còn TP/SL trên SoDEX. */
  maxHoldOff: boolean;
  /** Đóng vì max hold bị từ chối quá `maxCloseAttempts`: không thử nữa (Needs attention). */
  holdGaveUp: boolean;
  closedAt: number | null;
  closeReason: string | null;
}

export interface NewsSignalState {
  trades: Record<string, NewsTrade>;
  /** clOrdID → lệnh của trade nào, vai trò gì. Còn dòng = chiến lược còn chờ SoDEX báo kết thúc. */
  orders: Record<string, { signalId: string; role: Role }>;
  nextSeq: number;
  /** Tín hiệu đã xử lý → `expires_at`. */
  seen: Record<string, number>;
  /** Story key → giờ bắt đầu (bài sớm nhất đã tính) và lúc đã vào lệnh (khoá 7 ngày). */
  stories: Record<string, { start: number; enteredAt: number | null }>;
  /** Ngày UTC (YYYY-MM-DD) và số lệnh mới trong ngày đó. */
  day: string;
  dayCount: number;
  paused: boolean;
  /** Resume: tín hiệu quyết định trước mốc này là đã lỡ (`MISSED_WHILE_PAUSED`). */
  acceptAfter: number | null;
  stopping: "keep" | "close" | null;
  ledgers: Record<string, Ledger>;
}

export const initialNewsSignalState = (): NewsSignalState => ({
  trades: {},
  orders: {},
  nextSeq: 1,
  seen: {},
  stories: {},
  day: "",
  dayCount: 0,
  paused: false,
  acceptAfter: null,
  stopping: null,
  ledgers: {},
});

// ── Tiện ích ──────────────────────────────────────────────────────────────────────────────────────────────────────

type R = StepResult<NewsSignalState>;
const none = (s: NewsSignalState): R => ({ actions: [], state: s });
const utcDay = (at: number) => new Date(at).toISOString().slice(0, 10);
const position = (t: NewsTrade): Decimal => dec(t.filled).sub(t.exited);
const exitSide = (t: NewsTrade): "buy" | "sell" => (t.side === "long" ? "sell" : "buy");
const log = (decision: string, why: string): StrategyAction => ({ type: "log", decision, why });
const dropped = (
  signalId: string,
  reason: string,
  detail?: Record<string, string | number | boolean>,
): StrategyAction => ({
  type: "signalOutcome",
  signalId,
  outcome: "dropped",
  reason,
  ...(detail === undefined ? {} : { detail }),
});

/** Tag của các lệnh của một trade. SL kết thúc bằng `:sl` để engine nhận ra stop gốc (DEC-118). */
export const newsTag = {
  entry: (signalId: string) => `ns:${signalId}:entry`,
  tp: (signalId: string, editSeq: number) => `ns:${signalId}:e${String(editSeq)}:tp`,
  sl: (signalId: string, editSeq: number) => `ns:${signalId}:e${String(editSeq)}:sl`,
  close: (signalId: string, kind: CloseKind, commandSeq: number | null, round: number) =>
    `ns:${signalId}:${kind === "command" ? `close:${String(commandSeq)}` : kind}${round > 0 ? `:${String(round)}` : ""}`,
};

const orderId = (ctx: StepContext, t: Pick<NewsTrade, "seq">, tag: string, attempt = 0) =>
  clOrdId(ctx.botId, t.seq, tag, attempt);

function withTrade(s: NewsSignalState, t: NewsTrade): NewsSignalState {
  return { ...s, trades: { ...s.trades, [t.signalId]: t } };
}

function track(s: NewsSignalState, id: string, signalId: string, role: Role): NewsSignalState {
  return { ...s, orders: { ...s.orders, [id]: { signalId, role } } };
}

function untrack(s: NewsSignalState, id: string): NewsSignalState {
  return { ...s, orders: Object.fromEntries(Object.entries(s.orders).filter(([k]) => k !== id)) };
}

/** Trade đã đóng và không còn lệnh nào chờ kết thúc thì bỏ khỏi state (lịch sử nằm ở `news_signal_trades`). */
/**
 * Bỏ lệnh đã đóng, không còn lệnh SoDEX nào chờ và đã đóng quá `NEWS_SIGNAL.closedKeepMs` (`at` = giờ của bước; không có
 * thì chỉ giữ nguyên). Lệnh vừa đóng luôn còn trong state ở bước đóng nó, để engine ghi được trạng thái cuối.
 */
function prune(s: NewsSignalState, at?: number): NewsSignalState {
  if (at === undefined) return s;
  const live = new Set(Object.values(s.orders).map((o) => o.signalId));
  const trades = Object.fromEntries(
    Object.entries(s.trades).filter(
      ([id, t]) =>
        t.status !== "closed" || live.has(id) || at - (t.closedAt ?? at) < NEWS_SIGNAL.closedKeepMs,
    ),
  );
  return Object.keys(trades).length === Object.keys(s.trades).length ? s : { ...s, trades };
}

function place(order: OrderIntent): StrategyAction {
  return { type: "place", order };
}

function limitTp(
  ctx: StepContext,
  t: NewsTrade,
  seq: number,
  price: string,
  qty: string,
): OrderIntent {
  const tag = newsTag.tp(t.signalId, seq);
  return {
    clOrdID: orderId(ctx, t, tag),
    market: t.market,
    engine: "perps",
    side: exitSide(t),
    type: "limit",
    price,
    quantity: qty,
    timeInForce: "GTC",
    reduceOnly: true,
    tag,
  };
}

function stopSl(
  ctx: StepContext,
  t: NewsTrade,
  seq: number,
  price: string,
  qty: string,
): OrderIntent {
  const tag = newsTag.sl(t.signalId, seq);
  return {
    clOrdID: orderId(ctx, t, tag),
    market: t.market,
    engine: "perps",
    side: exitSide(t),
    type: "market",
    quantity: qty,
    timeInForce: "IOC",
    reduceOnly: true,
    tag,
    stop: { price },
  };
}

function marketClose(ctx: StepContext, t: NewsTrade, c: NewsClose, qty: string): OrderIntent {
  return {
    clOrdID: orderId(ctx, t, c.tag, c.attempt),
    market: t.market,
    engine: "perps",
    side: exitSide(t),
    type: "market",
    quantity: qty,
    timeInForce: "IOC",
    reduceOnly: true,
    tag: c.tag,
  };
}

/** Mọi lệnh còn sống của trade (TP, SL, chân đang chờ, lệnh đóng), không gồm lệnh đã gửi huỷ. */
function liveIds(t: NewsTrade): string[] {
  return [t.tp?.id, t.sl?.id, t.pending?.tp?.id, t.pending?.sl?.id, t.close?.id].filter(
    (id): id is string => id !== undefined,
  );
}

// ── Lọc tín hiệu ──────────────────────────────────────────────────────────────────────────────────────────────────

function rollDay(s: NewsSignalState, at: number): NewsSignalState {
  const day = utcDay(at);
  return s.day === day ? s : { ...s, day, dayCount: 0 };
}

function pruneMemory(s: NewsSignalState, at: number): NewsSignalState {
  const seen = Object.fromEntries(
    Object.entries(s.seen).filter(([, exp]) => exp + NEWS_SIGNAL.seenKeepMs > at),
  );
  const stories = Object.fromEntries(
    // Story chưa vào lệnh vẫn giữ (để trả STORY_TOO_OLD thay vì coi như story mới) tới hết cửa sổ 7 ngày.
    Object.entries(s.stories).filter(([, st]) => at - (st.enteredAt ?? st.start) < STORY_LOCK_MS),
  );
  return prune({ ...s, seen, stories }, at);
}

function onSignal(
  c: NewsSignalConfig,
  s0: NewsSignalState,
  e: Extract<StrategyEvent, { type: "newsSignal" }>,
  ctx: StepContext,
): R {
  const sig = e.signal;
  // Đã xử lý: không tạo hành động thứ hai (engine còn chặn bằng PK `news_signal_deliveries`).
  if (s0.seen[sig.id] !== undefined || s0.trades[sig.id] !== undefined) return none(s0);
  let s = pruneMemory(rollDay(s0, e.at), e.at);
  s = { ...s, seen: { ...s.seen, [sig.id]: sig.expiresAt } };
  const drop = (reason: string, detail?: Record<string, string | number | boolean>): R => ({
    actions: [dropped(sig.id, reason, detail)],
    state: s,
  });

  if (s.stopping !== null || s.paused) return drop(SignalReason.botPaused);
  if (s.acceptAfter !== null && sig.decidedAt < s.acceptAfter)
    return drop(SignalReason.missedWhilePaused);
  if (newsSignalStale(new Date(sig.decidedAt), new Date(e.at)) || e.at > sig.expiresAt)
    return drop(SignalReason.signalStale);
  const holdHours = versionHoldHours(c, sig.catalyst as SignalCatalyst);
  if (holdHours === null) return drop(SignalReason.newsTypeOff);
  if (!assetAllowed(c.assets, sig.market, sig.kind)) return drop(SignalReason.assetNotInBot);
  if (!levelAtLeast(sig.level, c.minLevel)) return drop(SignalReason.levelTooLow);
  if (sig.collectedAt - sig.firstPublishedAt > c.maxSourceDelayMinutes * 60_000)
    return drop(SignalReason.sourceLate);

  // Story: đã vào lệnh trong 7 ngày → gộp; chưa vào thì chỉ thử lại trong 2 giờ kể từ bài đầu tiên được tính.
  const story = s.stories[sig.storyKey];
  if (story?.enteredAt != null && e.at - story.enteredAt < STORY_LOCK_MS)
    return drop(SignalReason.sameStory);
  if (story !== undefined && storyTooOld(story.start, e.at)) return drop(SignalReason.storyTooOld);
  s = {
    ...s,
    stories: {
      ...s.stories,
      [sig.storyKey]: {
        start: Math.min(story?.start ?? sig.firstPublishedAt, sig.firstPublishedAt),
        enteredAt: null,
      },
    },
  };

  // Đã có lệnh news của bot này ở market đó: cùng chiều thì bỏ; ngược chiều theo "Opposite news" (không bao giờ đảo).
  const current = Object.values(s.trades).find(
    (t) => t.market === sig.market && t.status !== "closed",
  );
  if (current !== undefined) {
    if (current.side === sig.side) return drop(SignalReason.tradeOpen);
    if (c.onOppositeNews === "close" && current.status === "open" && current.close === null) {
      const r = startClose(s, ctx, current, "opposite", SignalReason.oppositeNews, null);
      return {
        actions: [
          {
            type: "signalOutcome",
            signalId: sig.id,
            outcome: "accepted",
            detail: { action: "close" },
          },
          log(
            "Opposite news",
            `${sig.market}: news points the other way. Closing the ${current.side} trade at market. The bot never flips.`,
          ),
          ...r.actions,
        ],
        state: r.state,
      };
    }
    return drop(SignalReason.tradeOpen, { opposite: true, policy: c.onOppositeNews });
  }
  if (e.accountMarketBusy === true) return drop(SignalReason.accountMarketBusy);

  const open = Object.values(s.trades).filter((t) => t.status !== "closed").length;
  if (open >= c.maxOpenTrades) return drop(SignalReason.limitOpen);
  if (c.maxNewTradesPerDay !== null && s.dayCount >= c.maxNewTradesPerDay)
    return drop(SignalReason.limitDay);

  const typical = sig.typicalByHoldHours[String(holdHours)];
  if (typical === undefined || typical === null) return drop(SignalReason.notEnoughHistory);
  const rules = ctx.rules[sig.market];
  if (rules === undefined) return drop(SignalReason.noPrice);
  const book = e.book ?? null;
  if (book === null) return drop(SignalReason.noBookData);
  const bid = dec(book.bid);
  const ask = dec(book.ask);
  if (!bid.gt(0) || ask.lt(bid)) return drop(SignalReason.noBookData);

  const tpPct = dec(typical).mul(c.tpMultiple);
  const slPct = dec(typical).mul(c.slMultiple);
  const mid = bid.add(ask).div(2);
  const spreadPct = ask.sub(bid).div(mid).mul(100);
  const oneWayPct = dec(ctx.takerFeeRate ?? ctx.feeRate).mul(100);
  const cost = costCheck(tpPct, roundTripCost(oneWayPct, spreadPct), c.minTpCostMultiple);
  if (cost !== null) return drop(cost);

  const limit = newsEntryLimitPrice({
    direction: sig.side,
    bid: book.bid,
    ask: book.ask,
    tickSize: rules.tickSize,
  });
  if (limit === null) return drop(SignalReason.noBookData);
  const size = Decimal.min(dec(c.sizeUsdc), dec(NEWS_SIGNAL_LIVE_MAX_USDC));
  const qty = roundQty(size.div(limit), rules);
  // Phòng thủ: giá trần × khối lượng không bao giờ vượt trần mainnet (DEC-360 mục 2).
  if (limit.mul(qty).gt(NEWS_SIGNAL_LIVE_MAX_USDC)) return drop(SignalReason.newsCapExceeded);
  if (!meetsMinimum(limit, qty, rules)) return drop(SignalReason.belowMinSize);

  const seq = s.nextSeq;
  const tag = newsTag.entry(sig.id);
  const base = { seq, signalId: sig.id };
  const entryId = orderId(ctx, base, tag);
  const trade: NewsTrade = {
    signalId: sig.id,
    storyKey: sig.storyKey,
    seq,
    market: sig.market,
    side: sig.side,
    status: "entering",
    sizeUsdc: size.toString(),
    entryId,
    entryAttempt: 0,
    entryLimit: limit.toString(),
    entryDone: false,
    filled: "0",
    filledNotional: "0",
    exited: "0",
    tpPct: tpPct.toString(),
    slPct: slPct.toString(),
    tp: null,
    sl: null,
    tpslSeq: 0,
    pending: null,
    resizeOwed: false,
    retiring: [],
    close: null,
    openedAt: e.at,
    maxHoldUntil: e.at + holdHours * HOUR_MS,
    maxHoldOff: false,
    holdGaveUp: false,
    closedAt: null,
    closeReason: null,
  };
  s = track(
    withTrade({ ...s, nextSeq: seq + 1, dayCount: s.dayCount + 1 }, trade),
    entryId,
    sig.id,
    "entry",
  );
  const order: OrderIntent = {
    clOrdID: entryId,
    market: sig.market,
    engine: "perps",
    side: sig.side === "long" ? "buy" : "sell",
    type: "limit",
    price: limit.toString(),
    quantity: qty,
    timeInForce: "IOC",
    reduceOnly: false,
    tag,
  };
  return {
    actions: [
      { type: "signalOutcome", signalId: sig.id, outcome: "accepted" },
      place(order),
      log(
        "News trade",
        `${sig.market} ${sig.side === "long" ? "Long" : "Short"}: ${sig.catalyst}, level ${sig.level}. Limit IOC ${qty} at up to ${priceText(limit, rules)}.`,
      ),
    ],
    state: s,
  };
}

// ── Lệnh vào, TP / SL ─────────────────────────────────────────────────────────────────────────────────────────────

function exitPrices(t: NewsTrade, ctx: StepContext): { tp: string; sl: string } | null {
  const rules = ctx.rules[t.market];
  if (rules === undefined || !dec(t.filled).gt(0)) return null;
  const avg = dec(t.filledNotional).div(t.filled);
  const long = t.side === "long";
  const up = (pct: string) => avg.mul(dec("100").add(pct)).div("100");
  const down = (pct: string) => avg.mul(dec("100").sub(pct)).div("100");
  // Làm tròn về phía gần giá vào (TP chốt sớm hơn một tick, SL cắt sớm hơn một tick), không bao giờ rộng hơn đã tính.
  return {
    tp: roundPrice(long ? up(t.tpPct) : down(t.tpPct), rules, long ? RoundMode.down : RoundMode.up),
    sl: roundPrice(long ? down(t.slPct) : up(t.slPct), rules, long ? RoundMode.up : RoundMode.down),
  };
}

/** Lệnh vào đã kết thúc. Không khớp gì → `ENTRY_NOT_FILLED`; có khớp → đặt SL + TP (hoặc đóng ngay khi đang Stop Close all). */
function entryEnded(s0: NewsSignalState, ctx: StepContext, t0: NewsTrade, at: number): R {
  let s = s0;
  const t: NewsTrade = { ...t0, entryDone: true };
  if (!dec(t.filled).gt(0)) {
    const closed: NewsTrade = {
      ...t,
      status: "closed",
      closedAt: at,
      closeReason: SignalReason.entryNotFilled,
    };
    return {
      actions: [
        log("Entry not filled", `${t.market}: no fill within the price cap. Signal skipped.`),
      ],
      state: prune(withTrade(s, closed)),
    };
  }
  // Story khoá 7 ngày chỉ khi đã thật sự vào lệnh.
  const story = s.stories[t.storyKey];
  s = {
    ...s,
    stories: { ...s.stories, [t.storyKey]: { start: story?.start ?? t.openedAt, enteredAt: at } },
  };
  // Lệnh vào kết thúc sau Stop "Keep open trades": cũng thôi áp max hold như các lệnh khác.
  const opened: NewsTrade = {
    ...t,
    status: "open",
    maxHoldOff: t.maxHoldOff || s.stopping === "keep",
  };
  // Đang Stop "Close all now": không đặt TP/SL, đóng ngay.
  if (s.stopping === "close") return startClose(s, ctx, opened, "stop", "STOP", null);
  return placeExits(s, ctx, opened);
}

function placeExits(s0: NewsSignalState, ctx: StepContext, t: NewsTrade): R {
  const prices = exitPrices(t, ctx);
  if (prices === null) {
    return {
      actions: [
        log(
          "TP/SL not placed",
          `${t.market}: no market rules for this market. Close the trade from the table.`,
        ),
        { type: "flag", needsAttention: true },
      ],
      state: withTrade(s0, t),
    };
  }
  const qty = position(t).toString();
  const sl = stopSl(ctx, t, t.tpslSeq, prices.sl, qty);
  const tp = limitTp(ctx, t, t.tpslSeq, prices.tp, qty);
  let s = withTrade(s0, {
    ...t,
    sl: { id: sl.clOrdID, price: prices.sl, qty },
    tp: { id: tp.clOrdID, price: prices.tp, qty },
  });
  s = track(track(s, sl.clOrdID, t.signalId, "sl"), tp.clOrdID, t.signalId, "tp");
  const rules = ctx.rules[t.market];
  const avg = dec(t.filledNotional).div(t.filled);
  return {
    actions: [
      place(sl),
      place(tp),
      log(
        "Trade opened",
        `${t.market} ${t.side === "long" ? "Long" : "Short"} ${qty} at ${priceText(avg, rules)}. TP ${prices.tp}, SL ${prices.sl} on SoDEX.`,
      ),
    ],
    state: s,
  };
}

/**
 * Lệnh vào khớp thêm sau khi TP / SL đã đặt (fill muộn, ví dụ sau đối soát): SL đóng cả vị thế nên giữ nguyên; TP đặt lại
 * theo khối lượng mới (`tpslSeq + 1`), xác nhận rồi mới huỷ TP cũ. TP đang chờ xác nhận thì để sau (không đặt chồng).
 */
function resizeTp(s: NewsSignalState, ctx: StepContext, t: NewsTrade): R {
  if (t.tp === null || t.status !== "open" || t.close !== null) return none(withTrade(s, t));
  if (t.pending !== null) return none(withTrade(s, { ...t, resizeOwed: true }));
  const qty = position(t).toString();
  if (dec(qty).lte(0) || dec(qty).eq(t.tp.qty))
    return none(withTrade(s, { ...t, resizeOwed: false }));
  const seq = t.tpslSeq + 1;
  const o = limitTp(ctx, t, seq, t.tp.price, qty);
  const pending: NewsPendingEdit = {
    seq,
    commandId: null,
    tp: { id: o.clOrdID, price: t.tp.price, qty, acked: false },
    sl: null,
    failed: null,
  };
  return {
    actions: [place(o)],
    state: track(withTrade(s, { ...t, pending, resizeOwed: false }), o.clOrdID, t.signalId, "tp"),
  };
}

// ── Đóng ──────────────────────────────────────────────────────────────────────────────────────────────────────────

function startClose(
  s: NewsSignalState,
  ctx: StepContext,
  t: NewsTrade,
  kind: CloseKind,
  reason: string,
  command: NewsCommandInput | null,
): R {
  const qty = position(t);
  if (!qty.gt(0)) return none(withTrade(s, t));
  const tag = newsTag.close(t.signalId, kind, command?.seq ?? null, 0);
  const close: NewsClose = {
    kind,
    id: orderId(ctx, t, tag),
    tag,
    attempt: 0,
    round: 0,
    commandId: command?.id ?? null,
    reason,
  };
  const order = marketClose(ctx, t, close, qty.toString());
  return {
    actions: [place(order)],
    state: track(
      withTrade(s, { ...t, status: "closing", close }),
      order.clOrdID,
      t.signalId,
      "close",
    ),
  };
}

/** Gửi lại lệnh đóng: `attempt + 1` khi bị từ chối, `round + 1` khi lệnh trước kết thúc mà vị thế còn. */
function resendClose(s0: NewsSignalState, ctx: StepContext, t: NewsTrade, rejected: boolean): R {
  const c = t.close;
  if (c === null) return none(s0);
  const qty = position(t);
  if (!qty.gt(0)) return none(withTrade(s0, { ...t, close: null }));
  const next: NewsClose = rejected
    ? { ...c, attempt: c.attempt + 1 }
    : {
        ...c,
        round: c.round + 1,
        attempt: 0,
        tag: newsTag.close(t.signalId, c.kind, closeSeq(c), c.round + 1),
      };
  next.id = orderId(ctx, t, next.tag, next.attempt);
  if (rejected && next.attempt >= NEWS_SIGNAL.maxCloseAttempts) {
    // Bỏ cuộc: lệnh vẫn mở, TP/SL còn trên SoDEX. Không thử max hold nữa; người dùng xử lý (Close now).
    const back: NewsTrade = {
      ...t,
      status: "open",
      close: null,
      holdGaveUp: t.holdGaveUp || c.kind === "hold",
    };
    const actions: StrategyAction[] = [
      log(
        "Close not done",
        `${t.market}: SoDEX rejected the close ${String(next.attempt)} times. TP and SL stay on SoDEX.`,
      ),
      { type: "flag", needsAttention: true },
    ];
    if (c.commandId !== null)
      actions.push({
        type: "commandResult",
        commandId: c.commandId,
        status: "rejected",
        code: "CLOSE_REJECTED",
      });
    return { actions, state: withTrade(s0, back) };
  }
  const order = marketClose(ctx, t, next, qty.toString());
  return {
    actions: [place(order)],
    state: track(withTrade(s0, { ...t, close: next }), order.clOrdID, t.signalId, "close"),
  };
}

const closeSeq = (c: NewsClose): number | null => {
  const m = /:close:(\d+)/.exec(c.tag);
  return m?.[1] === undefined ? null : Number(m[1]);
};

/** Vị thế về 0: trade đóng, huỷ mọi lệnh còn lại (OCO), báo kết quả lệnh Close now nếu có. */
function finish(s: NewsSignalState, t: NewsTrade, reason: string, at: number, filledBy: string): R {
  // Lệnh vừa đưa vị thế về 0 và lệnh đóng IOC tự kết thúc; còn lại (TP / SL / chân đang chờ) thì huỷ.
  const cancels = liveIds(t).filter((id) => id !== filledBy && id !== t.close?.id);
  const actions: StrategyAction[] = cancels
    .filter((id) => s.orders[id] !== undefined)
    .map((id) => ({ type: "cancel" as const, clOrdID: id }));
  if (t.close?.commandId != null)
    actions.push({ type: "commandResult", commandId: t.close.commandId, status: "applied" });
  if (t.pending?.commandId != null)
    actions.push({
      type: "commandResult",
      commandId: t.pending.commandId,
      status: "rejected",
      code: "TRADE_CLOSED",
    });
  actions.push(log(closeTitle(reason), `${t.market}: trade closed.`));
  const closed: NewsTrade = {
    ...t,
    status: "closed",
    closedAt: at,
    closeReason: reason,
    retiring: [...t.retiring, ...cancels],
    tp: null,
    sl: null,
    pending: null,
    close: null,
  };
  return { actions, state: prune(withTrade(s, closed)) };
}

function closeTitle(reason: string): string {
  switch (reason) {
    case SignalReason.takeProfit:
      return "Take profit";
    case SignalReason.stopLoss:
      return "Stop loss";
    case SignalReason.maxHold:
      return "Max hold";
    case SignalReason.oppositeNews:
      return "Closed on opposite news";
    case "STOP":
      return "Closed on stop";
    case "SL_REJECTED":
      return "Closed: stop loss rejected";
    default:
      return "Closed now";
  }
}

// ── Sự kiện lệnh ──────────────────────────────────────────────────────────────────────────────────────────────────

function onFill(
  s0: NewsSignalState,
  ctx: StepContext,
  e: Extract<StrategyEvent, { type: "fill" }>,
): R {
  // Lệnh vào đã báo kết thúc mà còn fill tới muộn (ví dụ đối soát tìm thấy trade): vẫn nhận theo `entryId`.
  const ref =
    s0.orders[e.clOrdID] ??
    Object.values(s0.trades)
      .filter((t) => t.entryId === e.clOrdID)
      .map((t) => ({ signalId: t.signalId, role: "entry" as const }))[0];
  if (ref === undefined) return none(s0);
  const t0 = s0.trades[ref.signalId];
  if (t0 === undefined) return none(s0);
  const side = ref.role === "entry" ? (t0.side === "long" ? "buy" : "sell") : exitSide(t0);
  const ledger = applyFill(
    s0.ledgers[t0.market] ?? emptyLedger(),
    side,
    e.price,
    e.quantity,
    e.fee,
  );
  const s: NewsSignalState = { ...s0, ledgers: { ...s0.ledgers, [t0.market]: ledger } };
  if (ref.role === "entry") {
    const t: NewsTrade = {
      ...t0,
      filled: dec(t0.filled).add(e.quantity).toString(),
      filledNotional: dec(t0.filledNotional).add(dec(e.price).mul(e.quantity)).toString(),
    };
    // Fill muộn sau khi đã đặt TP/SL: TP theo khối lượng mới.
    if (t.entryDone && t.status === "open") return resizeTp(s, ctx, t);
    if (t.entryDone && t.status === "closed") {
      // Trade đã đóng (vị thế về 0) mà lệnh vào khớp thêm: vị thế mở lại, đặt lại TP/SL.
      const reopened: NewsTrade = {
        ...t,
        status: "open",
        closedAt: null,
        closeReason: null,
        tpslSeq: t.tpslSeq + 1,
      };
      const r = placeExits(s, ctx, reopened);
      return {
        actions: [
          {
            type: "log",
            decision: "Late fill",
            why: `${t.market}: the entry filled after the trade closed. TP and SL placed again.`,
            teamAlert: "late_fill_adopted",
          },
          ...r.actions,
        ],
        state: r.state,
      };
    }
    return none(withTrade(s, t));
  }
  // Lệnh thoát: TP, SL, lệnh đóng (kể cả lệnh đã gửi huỷ mà vẫn khớp).
  let t: NewsTrade = { ...t0, exited: dec(t0.exited).add(e.quantity).toString() };
  // Fill của chân TP/SL mới đang chờ xác nhận = SoDEX đã nhận lệnh đó.
  if (t.pending !== null) {
    if (t.pending.tp?.id === e.clOrdID)
      t = { ...t, pending: { ...t.pending, tp: { ...t.pending.tp, acked: true } } };
    if (t.pending?.sl?.id === e.clOrdID)
      t = { ...t, pending: { ...t.pending, sl: { ...t.pending.sl, acked: true } } };
  }
  if (position(t).lte(0) && t.status !== "closed") {
    const reason =
      ref.role === "tp"
        ? SignalReason.takeProfit
        : ref.role === "sl"
          ? SignalReason.stopLoss
          : (t.close?.reason ?? "MANUAL");
    return finish(s, t, reason, e.at, e.clOrdID);
  }
  return t.pending === t0.pending ? none(withTrade(s, t)) : settleEdit(s, ctx, t);
}

function onAck(s: NewsSignalState, ctx: StepContext, id: string): R {
  const ref = s.orders[id];
  if (ref === undefined) return none(s);
  const t = s.trades[ref.signalId];
  const p = t?.pending ?? null;
  if (t === undefined || p === null) return none(s);
  const pending: NewsPendingEdit = {
    ...p,
    tp: p.tp?.id === id ? { ...p.tp, acked: true } : p.tp,
    sl: p.sl?.id === id ? { ...p.sl, acked: true } : p.sl,
  };
  return settleEdit(s, ctx, { ...t, pending });
}

/**
 * Chân mới của một lần sửa đều đã được SoDEX nhận → thay TP/SL hiện tại, rồi mới gửi huỷ lệnh cũ. Có chân bị từ chối →
 * huỷ các chân mới đã nhận, giữ lệnh cũ, báo `rejected`. Còn chân chưa có kết quả → chờ (không làm gì thêm).
 */
function settleEdit(s0: NewsSignalState, ctx: StepContext, t: NewsTrade): R {
  const p = t.pending;
  if (p === null) return none(withTrade(s0, t));
  const legs = [p.tp, p.sl].filter((l): l is NonNullable<typeof l> => l !== null);
  if (p.failed !== null) {
    // Chân còn chưa có kết quả: chờ. Chân đã nhận: huỷ (giữ lệnh cũ).
    const waiting = legs.filter((l) => !l.acked && s0.orders[l.id] !== undefined);
    if (waiting.length > 0) return none(withTrade(s0, t));
    const cancels = legs.filter((l) => s0.orders[l.id] !== undefined).map((l) => l.id);
    const actions: StrategyAction[] = cancels.map((id) => ({
      type: "cancel" as const,
      clOrdID: id,
    }));
    if (p.commandId !== null)
      actions.push({
        type: "commandResult",
        commandId: p.commandId,
        status: "rejected",
        code: p.failed,
      });
    actions.push(
      log(
        "TP/SL not changed",
        `${t.market}: SoDEX rejected the new order (${p.failed}). The old TP and SL stay.`,
      ),
    );
    const next: NewsTrade = { ...t, pending: null, retiring: [...t.retiring, ...cancels] };
    return after(withTrade(s0, next), ctx, next, actions);
  }
  if (!legs.every((l) => l.acked)) return none(withTrade(s0, t));
  const cancels: string[] = [];
  if (p.tp !== null && t.tp !== null) cancels.push(t.tp.id);
  if (p.sl !== null && t.sl !== null) cancels.push(t.sl.id);
  const next: NewsTrade = {
    ...t,
    tp: p.tp === null ? t.tp : { id: p.tp.id, price: p.tp.price, qty: p.tp.qty },
    sl: p.sl === null ? t.sl : { id: p.sl.id, price: p.sl.price, qty: p.sl.qty },
    tpslSeq: p.seq,
    pending: null,
    retiring: [...t.retiring, ...cancels],
  };
  const actions: StrategyAction[] = cancels
    .filter((id) => s0.orders[id] !== undefined)
    .map((id) => ({ type: "cancel" as const, clOrdID: id }));
  if (p.commandId !== null) {
    actions.push({ type: "commandResult", commandId: p.commandId, status: "applied" });
    actions.push(
      log(
        "TP/SL updated",
        `${t.market}: TP ${next.tp?.price ?? "not set"}, SL ${next.sl?.price ?? "not set"}.`,
      ),
    );
  }
  return after(withTrade(s0, next), ctx, next, actions);
}

/** Sau khi chỗ TP trống lại: đặt TP theo khối lượng mới nếu còn nợ. */
function after(s: NewsSignalState, ctx: StepContext, t: NewsTrade, actions: StrategyAction[]): R {
  if (!t.resizeOwed) return { actions, state: s };
  const r = resizeTp(s, ctx, t);
  return { actions: [...actions, ...r.actions], state: r.state };
}

function onEnded(
  s0: NewsSignalState,
  ctx: StepContext,
  id: string,
  at: number,
  reject: { code: string } | null,
): R {
  const ref = s0.orders[id];
  if (ref === undefined) return none(s0);
  let s = untrack(s0, id);
  const t0 = s.trades[ref.signalId];
  if (t0 === undefined) return none(s);
  const t: NewsTrade = { ...t0, retiring: t0.retiring.filter((x) => x !== id) };
  if (t0.retiring.includes(id)) return none(prune(withTrade(s, t)));

  switch (ref.role) {
    case "entry": {
      if (reject !== null && !dec(t.filled).gt(0)) {
        // Engine chặn lệnh trước khi gửi (#419 engine B1): ghi đúng mã chặn, không nói là SoDEX từ chối.
        const blocked = isNewsEntryBlock(reject.code);
        const closed: NewsTrade = {
          ...t,
          entryDone: true,
          status: "closed",
          closedAt: at,
          closeReason: blocked ? reject.code : SignalReason.entryNotFilled,
        };
        return {
          actions: [
            log(
              "Entry rejected",
              blocked
                ? `${t.market}: DeskLabs did not send the entry (${reject.code}). Signal skipped.`
                : `${t.market}: SoDEX rejected the entry (${reject.code}). Signal skipped.`,
            ),
          ],
          state: prune(withTrade(s, closed)),
        };
      }
      return entryEnded(s, ctx, t, at);
    }
    case "tp":
    case "sl": {
      const p = t.pending;
      const isPending = p !== null && (p.tp?.id === id || p.sl?.id === id);
      if (isPending) {
        if (reject !== null)
          return settleEdit(s, ctx, { ...t, pending: { ...p, failed: p.failed ?? reject.code } });
        // Chân mới kết thúc trước khi được xác nhận (ví dụ bị huỷ ngoài DeskLabs): coi như không đặt được.
        return settleEdit(s, ctx, { ...t, pending: { ...p, failed: p.failed ?? "ORDER_ENDED" } });
      }
      if (ref.role === "sl" && t.sl?.id === id && reject !== null && position(t).gt(0)) {
        // SL bị từ chối sau khi lệnh vào đã khớp (DEC-360 mục 4): đóng vị thế bằng market rồi pause ORDER_REJECTED.
        const base = withTrade(s, { ...t, sl: null });
        const r =
          t.close === null
            ? startClose(base, ctx, { ...t, sl: null }, "sl_rejected", "SL_REJECTED", null)
            : none(base);
        return {
          actions: [
            log(
              "Stop loss rejected",
              `${t.market}: SoDEX rejected the stop loss (${reject.code}). Closing the trade at market and pausing the bot.`,
            ),
            ...r.actions,
            { type: "pause", reason: ReasonCode.orderRejected },
          ],
          state: { ...r.state, paused: true },
        };
      }
      if (ref.role === "tp" && t.tp?.id === id && position(t).gt(0) && t.status !== "closed") {
        // TP bị từ chối / bị huỷ ngoài DeskLabs: SL và max hold vẫn bảo vệ; không tự đặt lại (không thử mù).
        const next: NewsTrade = { ...t, tp: null };
        return {
          actions: [
            log(
              "Take profit missing",
              `${t.market}: the take profit order is no longer on SoDEX${reject === null ? "" : ` (${reject.code})`}. Stop loss and max hold still apply. Use Edit TP/SL to set it again.`,
            ),
            { type: "flag", needsAttention: true },
          ],
          state: withTrade(s, next),
        };
      }
      if (ref.role === "sl" && t.sl?.id === id && position(t).gt(0) && t.status !== "closed") {
        // SL kết thúc mà vị thế còn (bị huỷ ngoài DeskLabs): báo người dùng, không tự đặt lại.
        return {
          actions: [
            log(
              "Stop loss missing",
              `${t.market}: the stop loss order is no longer on SoDEX. Use Edit TP/SL to set it again.`,
            ),
            { type: "flag", needsAttention: true },
          ],
          state: withTrade(s, { ...t, sl: null }),
        };
      }
      return none(prune(withTrade(s, t)));
    }
    case "close": {
      if (t.close?.id !== id) return none(prune(withTrade(s, t)));
      if (!position(t).gt(0)) return none(prune(withTrade(s, { ...t, close: null })));
      s = withTrade(s, t);
      return resendClose(s, ctx, t, reject !== null);
    }
  }
}

// ── Lệnh của người dùng ───────────────────────────────────────────────────────────────────────────────────────────

function onCommand(
  s: NewsSignalState,
  ctx: StepContext,
  e: Extract<StrategyEvent, { type: "newsCommand" }>,
): R {
  const cmd = e.command;
  const reject = (code: string): R => ({
    actions: [{ type: "commandResult", commandId: cmd.id, status: "rejected", code }],
    state: s,
  });
  const t = s.trades[cmd.signalId];
  if (t === undefined || t.status === "closed") return reject("TRADE_CLOSED");
  if (t.status === "entering" || !t.entryDone) return reject("TRADE_NOT_OPEN");
  if (t.close !== null || t.status === "closing") return reject("CLOSE_IN_PROGRESS");
  if (cmd.kind === "close") {
    const r = startClose(s, ctx, t, "command", "MANUAL", cmd);
    return {
      actions: [log("Close now", `${t.market}: closing at market.`), ...r.actions],
      state: r.state,
    };
  }
  // Edit TP/SL: một lần sửa mỗi lúc; lệnh mới đang chờ SoDEX (kể cả `unknown`) thì không đặt chồng.
  if (t.pending !== null) return reject("EDIT_IN_PROGRESS");
  const rules = ctx.rules[t.market];
  if (rules === undefined) return reject("NO_MARKET_RULES");
  const tp = cmd.tp === null ? null : roundPrice(cmd.tp, rules);
  const sl = cmd.sl === null ? null : roundPrice(cmd.sl, rules);
  if ((tp !== null && !dec(tp).gt(0)) || (sl !== null && !dec(sl).gt(0)))
    return reject("INVALID_PRICE");
  const tpAfter = tp ?? t.tp?.price ?? null;
  const slAfter = sl ?? t.sl?.price ?? null;
  if (tpAfter !== null && slAfter !== null) {
    const ok = t.side === "long" ? dec(slAfter).lt(tpAfter) : dec(slAfter).gt(tpAfter);
    if (!ok) return reject("INVALID_PRICE");
  }
  const qty = position(t).toString();
  const seq = t.tpslSeq + 1;
  const tpLeg = tp === null || tp === t.tp?.price ? null : limitTp(ctx, t, seq, tp, qty);
  const slLeg = sl === null || sl === t.sl?.price ? null : stopSl(ctx, t, seq, sl, qty);
  if (tpLeg === null && slLeg === null)
    return { actions: [{ type: "commandResult", commandId: cmd.id, status: "applied" }], state: s };
  const pending: NewsPendingEdit = {
    seq,
    commandId: cmd.id,
    tp: tpLeg === null ? null : { id: tpLeg.clOrdID, price: tp ?? "", qty, acked: false },
    sl: slLeg === null ? null : { id: slLeg.clOrdID, price: sl ?? "", qty, acked: false },
    failed: null,
  };
  let st = withTrade(s, { ...t, pending });
  const actions: StrategyAction[] = [];
  if (tpLeg !== null) {
    st = track(st, tpLeg.clOrdID, t.signalId, "tp");
    actions.push(place(tpLeg));
  }
  if (slLeg !== null) {
    st = track(st, slLeg.clOrdID, t.signalId, "sl");
    actions.push(place(slLeg));
  }
  return { actions, state: st };
}

// ── Nhịp đồng hồ, pause / resume / stop ───────────────────────────────────────────────────────────────────────────

function onTimer(s0: NewsSignalState, ctx: StepContext, at: number): R {
  let s = rollDay(s0, at);
  const actions: StrategyAction[] = [];
  for (const t of Object.values(s.trades)) {
    const due =
      t.status === "open" &&
      t.entryDone &&
      t.close === null &&
      !t.maxHoldOff &&
      !t.holdGaveUp &&
      at >= t.maxHoldUntil &&
      position(t).gt(0);
    if (!due) continue;
    const r = startClose(s, ctx, t, "hold", SignalReason.maxHold, null);
    s = r.state;
    actions.push(
      log("Max hold", `${t.market}: max hold reached. Closing at market.`),
      ...r.actions,
    );
  }
  return { actions, state: s };
}

function onStop(
  s0: NewsSignalState,
  ctx: StepContext,
  e: Extract<StrategyEvent, { type: "newsStop" }>,
): R {
  if (!e.close) {
    // Keep open trades: TP/SL ở lại SoDEX (engine không huỷ, xem `keepOnStop`), thôi áp max hold.
    const trades = Object.fromEntries(
      Object.entries(s0.trades).map(([id, t]) => [id, { ...t, maxHoldOff: true }]),
    );
    return { actions: [], state: { ...s0, trades, stopping: "keep" } };
  }
  let s: NewsSignalState = { ...s0, stopping: "close" };
  const actions: StrategyAction[] = [];
  for (const t of Object.values(s.trades)) {
    if (t.status !== "open" || t.close !== null || !position(t).gt(0)) continue;
    const r = startClose(s, ctx, t, "stop", "STOP", null);
    s = r.state;
    actions.push(...r.actions);
  }
  return { actions, state: s };
}

// ── Module ────────────────────────────────────────────────────────────────────────────────────────────────────────

export function stepNewsSignal(
  c: NewsSignalConfig,
  s: NewsSignalState,
  e: StrategyEvent,
  ctx: StepContext,
): R {
  switch (e.type) {
    case "newsSignal":
      return onSignal(c, s, e, ctx);
    case "newsCommand":
      return onCommand(s, ctx, e);
    case "newsStop":
      return onStop(s, ctx, e);
    case "paused":
      return none({ ...s, paused: true });
    case "resumed":
      // Resume không vào bù tín hiệu đã lỡ: chỉ nhận tín hiệu quyết định từ lúc này.
      return none({ ...s, paused: false, acceptAfter: e.at });
    case "fill":
      return onFill(s, ctx, e);
    case "orderAck":
      return onAck(s, ctx, e.clOrdID);
    case "orderDone":
      return onEnded(s, ctx, e.clOrdID, e.at, null);
    case "orderReject":
      return onEnded(s, ctx, e.clOrdID, e.at, { code: e.code });
    case "timer":
      return onTimer(s, ctx, e.at);
    case "fundingPaid": {
      const l = s.ledgers[e.market];
      if (l === undefined) return none(s);
      return none({
        ...s,
        ledgers: {
          ...s.ledgers,
          [e.market]: { ...l, funding: dec(l.funding).add(e.amount).toString() },
        },
      });
    }
    case "tick":
    case "fundingRate":
    case "marginRatio":
    case "positionSync":
    case "fair":
    case "book":
    case "leaderFill":
    case "leaderPosition":
      return none(s);
  }
}

/** Lệnh news đang có của bot (cho engine ghi `news_signal_trades`, trang research hiển thị). */
export const newsTrades = (s: NewsSignalState): NewsTrade[] => Object.values(s.trades);

export const newsSignal: StrategyModule<NewsSignalConfig, NewsSignalState> = {
  initialState: () => initialNewsSignalState(),
  step: stepNewsSignal,
  // Sửa bot (Markets / Min level / size…) chỉ áp khi không còn lệnh nào: lệnh đang mở giữ TP/SL của version cũ.
  applyVersion: (_c, s) =>
    Object.values(s.trades).some((t) => t.status !== "closed") || Object.keys(s.orders).length > 0
      ? null
      : s,
  awaitsEnd: (s, id) => s.orders[id] !== undefined,
  keepOnStop: (s) =>
    Object.values(s.trades).flatMap((t) =>
      t.status === "closed"
        ? []
        : [t.tp?.id, t.sl?.id, t.pending?.tp?.id, t.pending?.sl?.id].filter(
            (x): x is string => x !== undefined,
          ),
    ),
};

export type { NewsSignalInput, NewsCommandInput };
