import { dec, Decimal, NORMAL_REJECT_CODES, ReasonCode, RoundMode } from "@drift/shared";

import { clOrdId, fnv1a64 } from "../core/ids";
import { applyFill, emptyLedger, type Ledger } from "../core/ledger";
import { meetsMinimum, roundPrice, roundQty } from "../core/rounding";
import type {
  BookTop,
  OrderIntent,
  StepContext,
  StepResult,
  StrategyAction,
  StrategyEvent,
  StrategyModule,
} from "../core/types";

import type { VolumeFarmConfig } from "./schema";
import { farmSignal, type FarmRegime } from "./signal";

// S10 Volume Farm (DEC-80): vòng lặp FARM của bot "standard" trong apex (src/modules/Watcher.ts), viết lại dạng
// hàm thuần cho engine của DRIFT.
//   idle ──tín hiệu──▶ entering (post-only) ──fill──▶ open ──điều kiện thoát──▶ exiting ──đóng hết──▶ idle (cooldown)
// - Vào: hướng theo `farmSignal`; tồn kho ròng (Σ long − Σ short đã đóng) vượt `orderSizeMaxUsd` thì buộc đi ngược
//   lệnh trước (apex MM inventory hard block); `reverseSignal` đảo hướng. Cỡ lệnh và thời gian giữ ngẫu nhiên
//   (người dùng chọn giữ như apex, DEC-80), dùng PRNG tất định theo (botId, cycle) để backtest lặp lại được.
// - Lệnh vào post-only trong spread (mua = ask − 1 tick, bán = bid + 1 tick); 10 s chưa khớp thì huỷ, lượt sau đặt lại. Sau `takerAfter` lần
//   không khớp liên tiếp và `allowTaker` thì vào bằng lệnh market (IOC).
// - Thoát (thứ tự như apex): SL theo % giá → taker ngay; lãi ≥ max(tpUsd, 1.5 × phí khứ hồi); giữ ≥ maxHold;
//   sau earlyExitSecs lãi ≥ earlyProfitFees × phí khứ hồi (DEC-130); hết thời gian giữ ngẫu nhiên. Lệnh thoát post-only reduce-only cũng
//   đặt trong spread, 15 s không khớp thì huỷ và đặt lại; quá `takerAfter` lần thì market reduce-only.
// - Dừng: lỗ ròng (đã chốt + phí + funding) ≥ maxLoss → BOT_MAX_LOSS (engine đóng vị thế); đạt volumeTarget lúc
//   không có vị thế → MAX_CYCLES.
// - Stop loss gốc trên SoDEX (DEC-118): đặt ngay khi lệnh vào khớp, xa hơn SL của bot 25% khoảng SL. Lãi ≥ 1.5 ×
//   khoảng hoà vốn (phí vào + phí taker ra + trượt giá) thì dời stop trên sàn về hoà vốn, một lần (DEC-120).

/** Tên chế độ thị trường bằng lời thường cho Decisions (BD-03). */
const REGIME_TEXT: Record<FarmRegime, string> = {
  SIDEWAY: "a sideways market",
  TREND_UP: "an uptrend",
  TREND_DOWN: "a downtrend",
  HIGH_VOLATILITY: "a very volatile market",
  UNKNOWN: "a market without a clear trend",
};
export const FARM_TIMING = {
  entryFillMs: 10_000,
  exitFillMs: 15_000,
  /** Không có sổ lệnh thời gian thực (DEC-82): sổ REST cũ hơn mức này thì lùi 1 tick khỏi giá gần nhất. */
  bookMaxAgeMs: 10_000,
} as const;

/**
 * Sổ lệnh thời gian thực (DEC-TBD-vb-live-book): engine đưa giá tốt nhất SoDEX (WS `bookTicker`, cùng nguồn với Market
 * Making, DEC-248) vào `book` mỗi khi giá đổi, và gửi lại tối đa mỗi giây khi giá không đổi mà WS vẫn có tin.
 * - `freshMs`: sổ (WS hoặc bản đọc REST) cũ hơn mức này thì không đặt / đặt lại lệnh post-only từ nó, chờ bản mới.
 *   1,5 s: tin WS tới ít nhất mỗi giây khi stream còn sống, cộng 0,5 s cho trễ engine; bằng `freshMs` của Market Making.
 * - `feedMs`: có tin WS trong khoảng này = đang có nguồn thời gian thực, nên không bao giờ dùng giá gần nhất ± 1 tick
 *   cho lệnh post-only. Quá khoảng này (marketdata ngừng, market chưa được nghe) thì quay về cách của DEC-82.
 */
export const FARM_LIVE_BOOK = { freshMs: 1_500, feedMs: 60_000 } as const;

/**
 * Lệnh vào bị SoDEX từ chối vì lý do khác post-only / chặn tự khớp / thiếu margin (DEC-TBD-vb-reject-backoff): chờ
 * 5 s, rồi 15 s, rồi 60 s (giữ 60 s) trước lần vào kế tiếp. SoDEX nhận lệnh vào hoặc lệnh vào khớp thì về 0.
 */
export const VF_REJECT_BACKOFF_SECS = [5, 15, 60] as const;

/** Mã từ chối "bình thường": giá đã chạy (post-only) hoặc chặn tự khớp. Không chờ, lượt sau đặt lại như cũ. */
const NO_BACKOFF_CODES: readonly string[] = [
  ...Object.values(NORMAL_REJECT_CODES),
  // Mã giả lập của bot paper / backtest.
  "POST_ONLY_WOULD_TRADE",
];

type Kind = "entry" | "exit" | "stop";

export interface VolumeFarmState {
  phase: "idle" | "entering" | "open" | "exiting" | "halted";
  cycle: number;
  ledger: Ledger;
  lastPrice: string | null;
  book: BookTop | null;
  /** Lúc giá của `book` được xác nhận: tin WS, hoặc lúc engine đọc REST. */
  bookAt: number | null;
  /** Lần cuối nhận tin sổ lệnh WS (DEC-TBD-vb-live-book); thiếu ở state cũ. */
  bookStreamAt?: number | null;
  /**
   * Chờ sau khi lệnh vào bị từ chối vì lý do khác (DEC-TBD-vb-reject-backoff): `step` 1–3 theo
   * `VF_REJECT_BACKOFF_SECS`, `until` = lúc được vào lại.
   */
  rejectBackoff?: { step: number; until: number } | null;
  /** Lệnh của bot còn có thể khớp (kể cả đã gửi huỷ): fill đến muộn vẫn vào đúng sổ cái. */
  orders: Record<string, { kind: Kind; side: "buy" | "sell" }>;
  entry: { id: string; placedAt: number; taker: boolean } | null;
  exit: { id: string; placedAt: number; taker: boolean } | null;
  /** Lý do thoát của lượt hiện tại (ghi vào Decisions khi đóng xong). */
  exitReason: string | null;
  /** Thoát vì stop loss: mọi lần đặt lại đều là market, không rơi về post-only. */
  exitForce: boolean;
  openedAt: number | null;
  holdUntil: number | null;
  /** Thời gian giữ (s) đã chọn cho lượt đang vào. */
  holdSecs: number | null;
  cooldownUntil: number;
  unfilled: number;
  exitUnfilled: number;
  /** Lệnh vào market bị SoDEX từ chối liên tiếp (DEC-259); đủ `VF_MARKET_REJECTS` thì pause. */
  marketRejects?: number;
  lastSide: "long" | "short" | null;
  /** Σ notional các lượt long − Σ lượt short đã đóng (quote). */
  netExposure: string;
  /** Sổ cái lúc mở lượt hiện tại, để tính lãi / lỗ của riêng lượt đó. */
  openRealized: string;
  openFees: string;
  volume: string;
  trades: number;
  wins: number;
  lastSkip: string | null;
  lastSignal: {
    at: number;
    direction: "long" | "short" | "skip";
    score: number;
    confidence: number;
    regime: FarmRegime;
  } | null;
  /** Lệnh vào của lượt đang mở là taker: hoà vốn của stop tính phí taker cho chiều vào. */
  entryTaker?: boolean;
  /** State cũ (DEC-120): stop đã về hoà vốn. Đọc như `stopLevel` = 2. */
  breakEven?: boolean;
  /**
   * Nấc của stop trên SoDEX cho lượt đang mở (DEC-125): 0 = SL ban đầu, 1 = điểm vào lệnh, 2 = hoà vốn (đã gồm phí),
   * 3 = khoá lời và bám giá tốt nhất. Chỉ tăng, không bao giờ giảm.
   */
  stopLevel?: number;
  /** Giá tốt nhất từ lúc mở lượt (đỉnh khi long, đáy khi short), để bám ở nấc 3. */
  peak?: string | null;
  /** Nấc cao nhất đã ghi Decisions, để mỗi nấc chỉ ghi một lần. */
  stopLogged?: number;
  /** Stop loss gốc trên SoDEX của lượt đang mở (DEC-118): giá kích hoạt hiện tại, lần gửi / dời gần nhất. */
  xstop?: { id: string; price: string; at: number } | null;
  /** Lượt này không dùng stop trên sàn nữa (SoDEX từ chối): bot tự giữ SL như trước. */
  xstopOff?: boolean;
  /** Sàn không hỗ trợ stop loss gốc (Paper): không thử lại ở các lượt sau. */
  xstopUnsupported?: boolean;
  /**
   * Stop trên sàn của lượt đã đóng (DEC-119): SoDEX tự huỷ khi vị thế đóng nên bot không gọi huỷ ngay; lượt sau mới
   * gửi huỷ, engine bỏ qua nếu đối soát đã thấy SoDEX huỷ rồi.
   */
  staleXstop?: string | null;
}

/**
 * Stop loss gốc trên SoDEX (DEC-118): ban đầu đặt ở SL của bot lùi thêm `bufferPct` của giá vào (DEC-125, trước đây
 * lùi 25% khoảng SL, quá xa): bình thường bot tự thoát trước; market sập hoặc engine ngừng thì SoDEX đóng vị thế.
 */
export const FARM_XSTOP = {
  /** Khoảng lùi thêm sau SL của bot, tỷ lệ của giá vào (0.1%). */
  bufferPct: "0.001",
  /** Giữa hai lần dời stop trên sàn (mỗi lần là một lệnh ghi lên SoDEX). */
  modifyMs: 3_000,
} as const;

/**
 * Hoà vốn của stop (DEC-119): stop luôn khớp bằng lệnh market, nên chiều ra tính phí taker, cộng phần trượt giá
 * này (tỷ lệ của giá) để lượt đóng ở hoà vốn không thành lượt thua.
 */
export const FARM_BE_SLIPPAGE = "0.0001";
/**
 * Các nấc dời stop trên SoDEX, theo bội số của khoảng hoà vốn G (phí vào + phí taker ra + trượt giá), so với lãi lớn
 * nhất đã đạt của lượt (DEC-143, thay ngưỡng cố định của DEC-125):
 * - lãi ≥ `stopMoveFees` × G (cấu hình, mặc định 2): stop về hoà vốn (đã gồm phí);
 * - lãi ≥ (`stopMoveFees` + `lockAfter`) × G: stop khoá lời, bám giá tốt nhất cách `trail` × G, không thấp hơn hoà vốn.
 * Nấc "về điểm vào" của DEC-125 bỏ; state cũ đang ở nấc đó vẫn đọc được.
 */
// Ngưỡng chọn theo backtest BTC / ETH 1 phút (2026-11-06): dời về điểm vào ngay khi vừa đủ phí (1 G) làm stop nằm
// sát giá, bị nhiễu kích hoạt bằng market: chi phí mỗi 1M tăng 302 → 318 (BTC), 348 → 361 (ETH). 3 / 4 / 6 G, bám
// 2 G: 304 (BTC), 326 (ETH), ngang mức không đặt stop trên sàn (304 / 328).
export const FARM_STOP_LADDER = {
  lockAfter: "2",
  trail: "2",
} as const;

const initial = (): VolumeFarmState => ({
  phase: "idle",
  cycle: 0,
  ledger: emptyLedger(),
  lastPrice: null,
  book: null,
  bookAt: null,
  orders: {},
  entry: null,
  exit: null,
  exitReason: null,
  exitForce: false,
  openedAt: null,
  holdUntil: null,
  holdSecs: null,
  cooldownUntil: 0,
  unfilled: 0,
  exitUnfilled: 0,
  lastSide: null,
  netExposure: "0",
  openRealized: "0",
  openFees: "0",
  volume: "0",
  trades: 0,
  wins: 0,
  lastSkip: null,
  lastSignal: null,
});

/** Số lệnh vào market bị từ chối liên tiếp thì pause bot (DEC-117, bật lại ở DEC-259). */
export const VF_MARKET_REJECTS = 3;

const none = (s: VolumeFarmState): StepResult<VolumeFarmState> => ({ actions: [], state: s });

/** Số ngẫu nhiên tất định trong [0, 1) theo bot, lượt và mục đích. */
export function farmRandom(botId: string, cycle: number, salt: string): number {
  return Number(fnv1a64(`${botId}|${String(cycle)}|${salt}`) % 1_000_000n) / 1_000_000;
}

/** Giữ tối đa 12 lệnh gần nhất để nhận fill đến muộn mà state không phình. */
function remember(
  orders: VolumeFarmState["orders"],
  id: string,
  kind: Kind,
  side: "buy" | "sell",
): VolumeFarmState["orders"] {
  const entries = [...Object.entries(orders), [id, { kind, side }] as const];
  return Object.fromEntries(entries.slice(-12));
}

function dust(s: VolumeFarmState, ctx: StepContext, market: string): boolean {
  const pos = dec(s.ledger.position).abs();
  const rules = ctx.rules[market];
  return pos.isZero() || (rules !== undefined && pos.lt(rules.minQuantity));
}

function mark(s: VolumeFarmState): string | null {
  if (s.lastPrice !== null) return s.lastPrice;
  if (s.book === null) return null;
  return dec(s.book.bid).add(s.book.ask).div(2).toString();
}

/**
 * Khoảng cắt lỗ theo tỷ lệ giá (DEC-126): `slMarginPct` % margin ÷ đòn bẩy, như TP/SL của SoDEX. Config cũ có `slPct`
 * (% giá) thì dùng `slPct` để bot đang chạy giữ đúng mức cũ.
 */
export function farmStopFraction(c: VolumeFarmConfig): Decimal {
  if (c.slPct !== undefined) return dec(c.slPct).div(100);
  return dec(c.slMarginPct).div(100).div(c.leverage);
}

/** Mô tả SL trong Decisions: "25% of margin (1% price)" hoặc "5% price" với config cũ. */
function stopLabel(c: VolumeFarmConfig): string {
  const price = farmStopFraction(c).mul(100).toDecimalPlaces(3).toString();
  return c.slPct !== undefined
    ? `${price}% price`
    : `${c.slMarginPct}% of margin (${price}% price)`;
}

/** Giá hiển thị trong Decisions: làm tròn theo tick của market. */
function fmtPrice(v: Decimal, tick: string): string {
  return v.toDecimalPlaces(Math.max(0, dec(tick).decimalPlaces())).toString();
}

/** Lỗ ròng hiện tại của bot: đã chốt − phí − funding (chưa tính phần chưa chốt). */
export function farmNet(s: VolumeFarmState): Decimal {
  return dec(s.ledger.realized).sub(s.ledger.fees).sub(s.ledger.funding);
}

function intent(
  c: VolumeFarmConfig,
  ctx: StepContext,
  side: "buy" | "sell",
  qty: string,
  tag: string,
  price: string | null,
  reduceOnly: boolean,
): OrderIntent {
  const market = price === null;
  return {
    clOrdID: clOrdId(ctx.botId, ctx.version, tag),
    market: c.market,
    engine: "perps",
    side,
    type: market ? "market" : "limit",
    ...(market ? {} : { price }),
    quantity: qty,
    timeInForce: market ? "IOC" : "GTX",
    reduceOnly,
    tag,
  };
}

/** Đang có sổ lệnh thời gian thực (tin WS trong `FARM_LIVE_BOOK.feedMs`). */
function liveFeed(s: VolumeFarmState, at: number): boolean {
  return s.bookStreamAt != null && at - s.bookStreamAt <= FARM_LIVE_BOOK.feedMs;
}

/**
 * Giá post-only nằm trong spread theo `tickSize` của từng market (DEC-82): mua = ask tốt nhất − 1 tick, bán = bid tốt
 * nhất + 1 tick, để đứng đầu sổ và khớp nhanh. Spread chỉ 1 tick thì đứng cùng giá tốt nhất phía mình, không chéo sổ.
 * Sổ phải mới trong `FARM_LIVE_BOOK.freshMs` (DEC-TBD-vb-live-book). Lệnh vào: sổ cũ hơn mà đang có nguồn WS thì null
 * (chờ sổ mới, không đặt từ sổ cũ hay giá gần nhất). Lệnh thoát không bao giờ bị chặn (vị thế phải đóng được), và lệnh vào
 * khi không có nguồn WS: như DEC-82, sổ ≤ 10 s, không thì lùi 1 tick khỏi giá gần nhất.
 */
function makerPrice(
  c: VolumeFarmConfig,
  s: VolumeFarmState,
  ctx: StepContext,
  side: "buy" | "sell",
  at: number,
  exit = false,
) {
  const rules = ctx.rules[c.market];
  if (rules === undefined) return null;
  const tick = dec(rules.tickSize);
  const book = s.book;
  const age = s.bookAt === null ? Infinity : at - s.bookAt;
  const usable = book !== null && dec(book.bid).gt(0) && dec(book.ask).gt(book.bid);
  const fromBook = (b: BookTop) => {
    const bid = dec(b.bid);
    const ask = dec(b.ask);
    return side === "buy"
      ? roundPrice(Decimal.max(bid, ask.sub(tick)), rules, RoundMode.down)
      : roundPrice(Decimal.min(ask, bid.add(tick)), rules, RoundMode.up);
  };
  if (usable && age <= FARM_LIVE_BOOK.freshMs) return fromBook(book);
  if (!exit && liveFeed(s, at)) return null;
  if (usable && age <= FARM_TIMING.bookMaxAgeMs) return fromBook(book);
  const m = mark(s);
  if (m === null) return null;
  return side === "buy"
    ? roundPrice(dec(m).sub(tick), rules, RoundMode.down)
    : roundPrice(dec(m).add(tick), rules, RoundMode.up);
}

function halt(s: VolumeFarmState, reason: ReasonCode, why: string): StepResult<VolumeFarmState> {
  const cancels: StrategyAction[] = [
    s.entry?.id,
    s.exit?.id,
    s.xstop?.id,
    s.staleXstop ?? undefined,
  ].flatMap((id) => (id === undefined ? [] : [{ type: "cancel" as const, clOrdID: id }]));
  return {
    actions: [
      ...cancels,
      { type: "log", decision: "Volume Farm stopped", why },
      // Engine đóng vị thế còn lại bằng lệnh reduce-only theo sổ cái.
      { type: "stop", reason, close: true },
    ],
    state: { ...s, phase: "halted", entry: null, exit: null, xstop: null },
  };
}

function guards(c: VolumeFarmConfig, s: VolumeFarmState, ctx: StepContext) {
  const net = farmNet(s);
  if (net.neg().gte(c.maxLoss))
    return halt(
      s,
      ReasonCode.botMaxLoss,
      `Net loss ${net.neg().toDecimalPlaces(2).toString()} reached the max loss of ${c.maxLoss}.`,
    );
  if (c.volumeTarget !== undefined && dec(s.volume).gte(c.volumeTarget) && dust(s, ctx, c.market))
    return halt(s, ReasonCode.maxCycles, `Volume target ${c.volumeTarget} reached.`);
  return null;
}

function tryEnter(
  c: VolumeFarmConfig,
  s: VolumeFarmState,
  ctx: StepContext,
  at: number,
  candles: Parameters<typeof farmSignal>[0],
): StepResult<VolumeFarmState> {
  const rules = ctx.rules[c.market];
  if (rules === undefined) return none(s);
  if (at < s.cooldownUntil) return none(s);
  // Lệnh vào trước bị SoDEX từ chối vì lý do khác (DEC-TBD-vb-reject-backoff): chờ hết thời gian.
  if (s.rejectBackoff != null && at < s.rejectBackoff.until) return none(s);
  if (c.blockedHoursUtc.includes(new Date(at).getUTCHours())) {
    const why = `Hour ${String(new Date(at).getUTCHours())}:00 UTC is blocked.`;
    return s.lastSkip === why
      ? none(s)
      : { actions: [{ type: "log", decision: "Waiting", why }], state: { ...s, lastSkip: why } };
  }
  const sig = farmSignal(candles, s.book, at, Number(c.maxSpreadBps));
  const lastSignal = {
    at,
    direction: sig.direction,
    score: sig.score,
    confidence: sig.confidence,
    regime: sig.regime,
  };
  // Câu Decisions bằng lời thường (BD-03): `code` cố định để chỉ ghi khi lý do đổi (Decisions không lặp mỗi 5 s),
  // `why` là câu người dùng đọc.
  const skipEntry = (code: string, why: string): StepResult<VolumeFarmState> => {
    const state = { ...s, lastSignal, lastSkip: code };
    return s.lastSkip === code
      ? none(state)
      : { actions: [{ type: "log", decision: "Skipped entry", why }], state };
  };
  const regime = REGIME_TEXT[sig.regime];
  if (sig.direction === "skip") {
    const code = sig.reason.split(":")[0] ?? sig.reason;
    if (code === "COUNTER_TREND_BLOCKED")
      return skipEntry(
        code,
        `The signal pointed ${sig.score >= 0.5 ? "long" : "short"} against ${regime}, so the bot waits. Details: score ${sig.score.toFixed(2)}.`,
      );
    if (code === "SPREAD_TOO_WIDE" && sig.spreadBps !== null)
      return skipEntry(
        code,
        `The spread is ${sig.spreadBps.toFixed(1)} bp, wider than the ${c.maxSpreadBps} bp limit, so the bot waits.`,
      );
    return skipEntry(code, sig.reason);
  }
  // DEC-158: lượt vào khi có xu hướng tốn 385–659 mỗi 1M so với 143–169 khi đi ngang (export BTC / ETH 11-10, 11-11).
  if (c.sidewaysOnly && sig.regime !== "SIDEWAY")
    return skipEntry(
      "SIDEWAYS_ONLY",
      `Right now it is ${regime}, and this bot only trades sideways markets.`,
    );
  let direction: "long" | "short" = sig.direction;
  const notes: string[] = [];
  // Tồn kho ròng vượt một lệnh lớn nhất: buộc đi ngược lượt trước (apex MM inventory hard block).
  if (dec(s.netExposure).abs().gt(c.orderSizeMaxUsd) && s.lastSide !== null) {
    direction = s.lastSide === "long" ? "short" : "long";
    notes.push(`Went ${direction} to bring the position back toward zero.`);
  }
  if (c.reverseSignal) {
    direction = direction === "long" ? "short" : "long";
    notes.push(`Reversed to ${direction} because "Reverse the signal" is on.`);
    // DEC-158: chặn ngược xu hướng nằm trong farmSignal, chạy trước khi đảo; kiểm lại trên hướng sau khi đảo để
    // Reverse không mở lệnh ngược xu hướng (bot BTC 11-11: 116 / 116 lượt long giữa lúc giá giảm).
    if (
      (sig.regime === "TREND_UP" && direction === "short") ||
      (sig.regime === "TREND_DOWN" && direction === "long")
    )
      return skipEntry(
        "COUNTER_TREND_BLOCKED",
        `"Reverse the signal" would trade ${direction} against ${regime}, so the bot waits.`,
      );
  }
  const side = direction === "long" ? "buy" : "sell";
  const cycle = s.cycle + 1;
  const min = dec(c.orderSizeMinUsd);
  const usd = min.add(
    dec(c.orderSizeMaxUsd)
      .sub(min)
      .mul(farmRandom(ctx.botId, cycle, "size")),
  );
  const holdSecs =
    c.minHoldSecs +
    Math.floor(farmRandom(ctx.botId, cycle, "hold") * (c.maxHoldSecs - c.minHoldSecs + 1));
  const taker = c.allowTaker && s.unfilled >= c.takerAfter;
  const price = taker ? null : makerPrice(c, s, ctx, side, at);
  const ref = price ?? mark(s);
  if (ref === null) return none(s);
  const qty = roundQty(usd.div(ref), rules);
  if (!meetsMinimum(ref, qty, rules)) {
    const why = `Order ${usd.toDecimalPlaces(2).toString()} USDC is below the SoDEX minimum.`;
    return s.lastSkip === why
      ? none(s)
      : {
          actions: [{ type: "log", decision: "Skipped entry", why }],
          state: { ...s, lastSkip: why },
        };
  }
  if (!taker && price === null) {
    // Sổ lệnh cũ mà đang có nguồn WS (DEC-TBD-vb-live-book): chờ sổ mới, ghi một dòng cho mỗi đợt chờ.
    if (!liveFeed(s, at)) return none(s);
    const code = "STALE_BOOK";
    return s.lastSkip === code
      ? none(s)
      : {
          actions: [
            {
              type: "log",
              decision: "Waiting",
              why: "Waiting for a fresh SoDEX price before placing a post-only order.",
            },
          ],
          state: { ...s, lastSkip: code },
        };
  }
  const o = intent(c, ctx, side, qty, `vf:${String(cycle)}:in:${String(s.unfilled)}`, price, false);
  // BD-03: câu đầu bằng lời thường (tín hiệu, điều chỉnh, lệnh), chi tiết kỹ thuật sau "Details:".
  const at_ = price === null ? `Market order, last price ${ref}` : `Post-only at ${price}`;
  const why = [
    `Signal pointed ${sig.direction} in ${regime}.`,
    ...notes,
    `${at_}, ${usd.toDecimalPlaces(2).toString()} USDC, hold ${String(holdSecs)} s.`,
    `Details: score ${sig.score.toFixed(2)}, confidence ${sig.confidence.toFixed(2)}.`,
  ].join(" ");
  return {
    actions: [
      // Stop của lượt trước chưa chắc đã được SoDEX huỷ: gửi huỷ; engine bỏ qua nếu đã xác nhận huỷ (DEC-119).
      ...(s.staleXstop == null ? [] : [{ type: "cancel" as const, clOrdID: s.staleXstop }]),
      { type: "place", order: o },
      { type: "log", decision: `Enter ${direction}`, why },
    ],
    state: {
      ...s,
      staleXstop: null,
      phase: "entering",
      cycle,
      orders: remember(s.orders, o.clOrdID, "entry", side),
      entry: { id: o.clOrdID, placedAt: at, taker },
      holdSecs,
      lastSkip: null,
      lastSignal,
    },
  };
}

/** Điều kiện thoát (thứ tự của apex `_evaluateExitConditions`); null = giữ tiếp. */
function exitReason(
  c: VolumeFarmConfig,
  s: VolumeFarmState,
  ctx: StepContext,
  at: number,
): { why: string; stop: boolean } | null {
  const m = mark(s);
  if (m === null || s.openedAt === null) return null;
  const pos = dec(s.ledger.position);
  const avg = dec(s.ledger.avgCost);
  const long = pos.gt(0);
  const sl = farmStopFraction(c);
  if (
    long ? dec(m).lte(avg.mul(new Decimal(1).sub(sl))) : dec(m).gte(avg.mul(new Decimal(1).add(sl)))
  )
    return { why: `Stop loss ${stopLabel(c)} at ${m}`, stop: true };
  const pnl = pos.mul(dec(m).sub(avg));
  // Phí khứ hồi theo loại lệnh thật (DEC-259): chiều vào theo lệnh đã khớp, chiều ra là taker khi bot chạy
  // toàn taker (`takerAfter` 0); không thì maker như trước. Tính theo maker cả hai chiều thì TP / early profit ở chế
  // độ taker chốt "lãi" mà vẫn lỗ sau phí.
  const maker = dec(ctx.feeRate);
  const takerRate = dec(ctx.takerFeeRate ?? ctx.feeRate);
  const entryFee = s.entryTaker === true ? takerRate : maker;
  const exitFee = c.allowTaker && c.takerAfter === 0 ? takerRate : maker;
  const feeRt = pos.abs().mul(avg).mul(entryFee.add(exitFee));
  const tp = Decimal.max(dec(c.tpUsd), feeRt.mul("1.5"));
  const held = Math.floor((at - s.openedAt) / 1000);
  const p = pnl.toDecimalPlaces(2).toString();
  if (pnl.gte(tp))
    return { why: `Take profit: ${p} ≥ ${tp.toDecimalPlaces(2).toString()}`, stop: false };
  if (held >= c.maxHoldSecs) return { why: `Max hold ${String(held)} s (PnL ${p})`, stop: false };
  const early = Decimal.max(feeRt.mul(c.earlyProfitFees), dec(c.earlyProfitUsd ?? "0"));
  if (held >= c.earlyExitSecs && pnl.gte(early))
    return {
      why: `Early profit ${p} ≥ ${early.toDecimalPlaces(2).toString()} after ${String(held)} s`,
      stop: false,
    };
  if (s.holdUntil !== null && at >= s.holdUntil)
    return { why: `Hold time ${String(held)} s ended (PnL ${p})`, stop: false };
  return null;
}

/**
 * Khoảng hoà vốn (giá) của lượt đang mở cho stop trên sàn (DEC-119): stop khớp bằng market nên chiều ra tính phí
 * taker, chiều vào theo loại lệnh đã khớp, cộng trượt giá.
 */
function breakEvenGap(s: VolumeFarmState, ctx: StepContext): Decimal {
  const taker = dec(ctx.takerFeeRate ?? ctx.feeRate);
  const entry = s.entryTaker === true ? taker : dec(ctx.feeRate);
  return dec(s.ledger.avgCost).mul(entry.add(taker).add(FARM_BE_SLIPPAGE));
}

/** Nấc hiện tại của stop (state cũ có `breakEven` thì là nấc 2). */
const levelOf = (s: VolumeFarmState): number =>
  Math.max(s.stopLevel ?? 0, s.breakEven === true ? 2 : 0);

/** Cập nhật giá tốt nhất và nấc stop theo lãi lớn nhất đã đạt (DEC-125). Chỉ khi bật stop trên SoDEX. */
function trackStopLevel(
  c: VolumeFarmConfig,
  s: VolumeFarmState,
  ctx: StepContext,
): VolumeFarmState {
  const m = mark(s);
  if (!c.exchangeStop || m === null || s.phase !== "open") return s;
  const pos = dec(s.ledger.position);
  if (pos.isZero()) return s;
  const long = pos.gt(0);
  const avg = dec(s.ledger.avgCost);
  const prev = s.peak == null ? avg : dec(s.peak);
  const peak = long ? Decimal.max(prev, m) : Decimal.min(prev, m);
  const gain = long ? peak.sub(avg) : avg.sub(peak);
  const g = breakEvenGap(s, ctx);
  const be = dec(c.stopMoveFees);
  const reached = gain.gte(g.mul(be.add(FARM_STOP_LADDER.lockAfter)))
    ? 3
    : gain.gte(g.mul(be))
      ? 2
      : 0;
  const stopLevel = Math.max(levelOf(s), reached);
  const peakStr = peak.toString();
  if (stopLevel === s.stopLevel && peakStr === s.peak) return s;
  return { ...s, stopLevel, peak: peakStr };
}

/** Mức stop theo nấc (giá), null ở nấc 0. */
function ladderStop(s: VolumeFarmState, ctx: StepContext): Decimal | null {
  const level = levelOf(s);
  if (level === 0) return null;
  const long = dec(s.ledger.position).gt(0);
  const avg = dec(s.ledger.avgCost);
  const g = breakEvenGap(s, ctx);
  const be = long ? avg.add(g) : avg.sub(g);
  if (level === 1) return avg;
  if (level === 2) return be;
  const peak = dec(s.peak ?? avg);
  const trail = g.mul(FARM_STOP_LADDER.trail);
  return long ? Decimal.max(be, peak.sub(trail)) : Decimal.min(be, peak.add(trail));
}

/**
 * Giá kích hoạt của stop trên sàn: SL của bot lùi thêm `bufferPct` của giá vào; khi đã lên nấc thì là mức của nấc
 * (không bao giờ lùi lại). Làm tròn về phía an toàn: ở nấc thì làm tròn về phía có lãi.
 */
function xstopTarget(c: VolumeFarmConfig, s: VolumeFarmState, ctx: StepContext): string | null {
  const rules = ctx.rules[c.market];
  const pos = dec(s.ledger.position);
  if (rules === undefined || pos.isZero()) return null;
  const long = pos.gt(0);
  const avg = dec(s.ledger.avgCost);
  const distance = avg.mul(farmStopFraction(c)).add(avg.mul(FARM_XSTOP.bufferPct));
  const initial = long ? avg.sub(distance) : avg.add(distance);
  const ladder = ladderStop(s, ctx);
  const raw =
    ladder === null ? initial : long ? Decimal.max(initial, ladder) : Decimal.min(initial, ladder);
  if (!raw.gt(0)) return null;
  const onLadder = ladder !== null && raw.eq(ladder);
  const mode = long === onLadder ? RoundMode.up : RoundMode.down;
  return roundPrice(raw, rules, mode);
}

/** Câu Decisions khi stop trên sàn lên một nấc mới. */
function ladderLog(level: number, target: string, avg: string): StrategyAction {
  const decision =
    level === 1
      ? "Stop loss on SoDEX moved to entry"
      : level === 2
        ? "Stop loss on SoDEX moved to break-even"
        : "Stop loss on SoDEX locked in profit";
  const why =
    level === 1
      ? `Price covered the fees; SoDEX now closes at ${target} (entry ${avg}), so the trade loses at most its fees.`
      : level === 2
        ? `The position is in profit; SoDEX now closes it at ${target} or better (fees included).`
        : `SoDEX now closes at ${target} or better, locking in a profit, and follows the best price.`;
  return { type: "log", decision, why };
}

const xstopEnabled = (c: VolumeFarmConfig, s: VolumeFarmState) =>
  c.exchangeStop && s.xstopOff !== true && s.xstopUnsupported !== true;

/** Đặt stop trên sàn ngay khi có vị thế, hoặc dời lên khi SL của bot tốt hơn (DEC-118). */
function syncXstop(
  c: VolumeFarmConfig,
  s: VolumeFarmState,
  ctx: StepContext,
  at: number,
): StepResult<VolumeFarmState> {
  if (!xstopEnabled(c, s) || dust(s, ctx, c.market)) return none(s);
  const rules = ctx.rules[c.market];
  const target = xstopTarget(c, s, ctx);
  if (rules === undefined || target === null) return none(s);
  const long = dec(s.ledger.position).gt(0);
  const x = s.xstop ?? null;
  if (x === null) {
    const side = long ? "sell" : "buy";
    const qty = roundQty(dec(s.ledger.position).abs(), rules);
    const o: OrderIntent = {
      ...intent(c, ctx, side, qty, `vf:${String(s.cycle)}:sl`, null, true),
      stop: { price: target },
    };
    // Giá sẽ dời stop về hoà vốn (DEC-143), ghi kèm để người dùng biết vì sao stop chưa đổi.
    const avg = dec(s.ledger.avgCost);
    const move = breakEvenGap(s, ctx).mul(c.stopMoveFees);
    const trigger = roundPrice(
      long ? avg.add(move) : avg.sub(move),
      rules,
      long ? RoundMode.up : RoundMode.down,
    );
    const movePct = move.div(avg).mul(100).toDecimalPlaces(3).toString();
    return {
      actions: [
        { type: "place", order: o },
        {
          type: "log",
          decision: "Stop loss set on SoDEX",
          why: `SoDEX closes the whole position at market if the mark price reaches ${target}, even if DeskLabs is offline. Moves to break-even if the price reaches ${trigger} (${long ? "+" : "−"}${movePct}%).`,
        },
      ],
      state: {
        ...s,
        orders: remember(s.orders, o.clOrdID, "stop", side),
        xstop: { id: o.clOrdID, price: target, at },
      },
    };
  }
  const better = long ? dec(target).gt(x.price) : dec(target).lt(x.price);
  if (!better || at - x.at < FARM_XSTOP.modifyMs) return none(s);
  const level = levelOf(s);
  const logNow = level > (s.stopLogged ?? 0);
  const avg = fmtPrice(dec(s.ledger.avgCost), rules.tickSize);
  return {
    actions: [
      { type: "modifyStop", clOrdID: x.id, stopPrice: target },
      ...(logNow ? [ladderLog(level, target, avg)] : []),
    ],
    state: { ...s, xstop: { ...x, price: target, at }, ...(logNow ? { stopLogged: level } : {}) },
  };
}

function watchOpen(
  c: VolumeFarmConfig,
  s: VolumeFarmState,
  ctx: StepContext,
  at: number,
): StepResult<VolumeFarmState> {
  const tracked = syncXstop(c, trackStopLevel(c, s, ctx), ctx, at);
  const reason = exitReason(c, tracked.state, ctx, at);
  if (reason === null) return tracked;
  const r = startExit(c, tracked.state, ctx, at, reason);
  return { actions: [...tracked.actions, ...r.actions], state: r.state };
}

function placeExit(
  c: VolumeFarmConfig,
  s: VolumeFarmState,
  ctx: StepContext,
  at: number,
  forceTaker: boolean,
): StepResult<VolumeFarmState> {
  const rules = ctx.rules[c.market];
  if (rules === undefined) return none(s);
  const pos = dec(s.ledger.position);
  const side = pos.gt(0) ? "sell" : "buy";
  const taker = forceTaker || s.exitForce || (c.allowTaker && s.exitUnfilled >= c.takerAfter);
  const price = taker ? null : makerPrice(c, s, ctx, side, at, true);
  if (!taker && price === null) return none(s);
  const qty = roundQty(pos.abs(), rules);
  const o = intent(
    c,
    ctx,
    side,
    qty,
    `vf:${String(s.cycle)}:out:${String(s.exitUnfilled)}`,
    price,
    true,
  );
  return {
    actions: [{ type: "place", order: o }],
    state: {
      ...s,
      phase: "exiting",
      orders: remember(s.orders, o.clOrdID, "exit", side),
      exit: { id: o.clOrdID, placedAt: at, taker },
    },
  };
}

function startExit(
  c: VolumeFarmConfig,
  s: VolumeFarmState,
  ctx: StepContext,
  at: number,
  reason: { why: string; stop: boolean },
): StepResult<VolumeFarmState> {
  // Phần lệnh vào còn treo (khớp một phần) phải huỷ trước, không thì vị thế lớn thêm khi đang thoát.
  const cancels: StrategyAction[] =
    s.entry === null ? [] : [{ type: "cancel", clOrdID: s.entry.id }];
  const r = placeExit(
    c,
    { ...s, entry: null, exitReason: reason.why, exitForce: reason.stop },
    ctx,
    at,
    reason.stop,
  );
  return { actions: [...cancels, ...r.actions], state: r.state };
}

/**
 * Bản đọc REST (mỗi 3 s) vào sổ của bot. Tin WS còn mới (`freshMs`) hoặc mới hơn bản đọc REST thì giữ giá WS, chỉ lấy
 * độ dày (notional) từ REST, như Market Making (DEC-248). Không thì dùng bản REST, tính tuổi theo lúc engine đọc.
 */
function mergeRestBook(
  s: VolumeFarmState,
  snap: NonNullable<Extract<StrategyEvent, { type: "timer" }>["market"]>,
  at: number,
): VolumeFarmState {
  const readAt = snap.bookAt ?? at;
  const rest = snap.book;
  const wsFresh =
    s.book !== null &&
    s.bookStreamAt != null &&
    (at - s.bookStreamAt <= FARM_LIVE_BOOK.freshMs || (s.bookAt !== null && s.bookAt > readAt));
  if (wsFresh && s.book !== null) {
    return rest === null
      ? s
      : {
          ...s,
          book: { ...s.book, bidNotional: rest.bidNotional, askNotional: rest.askNotional },
        };
  }
  return { ...s, book: rest, bookAt: rest === null ? s.bookAt : readAt };
}

/** Giá tốt nhất SoDEX qua WS (DEC-TBD-vb-live-book): lưu giá, giữ độ dày của bản REST gần nhất. */
function onLiveBook(
  c: VolumeFarmConfig,
  s: VolumeFarmState,
  e: Extract<StrategyEvent, { type: "book" }>,
): StepResult<VolumeFarmState> {
  if (e.market !== c.market || !dec(e.bid).gt(0) || !dec(e.ask).gt(e.bid)) return none(s);
  const book: BookTop = {
    bid: e.bid,
    ask: e.ask,
    bidNotional: s.book?.bidNotional ?? "0",
    askNotional: s.book?.askNotional ?? "0",
  };
  return none({ ...s, book, bookAt: e.at, bookStreamAt: e.at });
}

/**
 * Lệnh vào bị từ chối vì lý do khác (DEC-TBD-vb-reject-backoff): lên một nấc chờ (5 → 15 → 60 s, giữ 60 s). Mỗi nấc mới
 * ghi một dòng Decisions; ở nấc cuối không ghi lại (engine đã ghi "Order refused by SoDEX" tối đa mỗi phút, DEC-291).
 */
function backoff(
  s: VolumeFarmState,
  e: Extract<StrategyEvent, { type: "orderReject" }>,
): { state: Pick<VolumeFarmState, "rejectBackoff">; actions: StrategyAction[] } {
  const prev = s.rejectBackoff?.step ?? 0;
  const step = Math.min(prev + 1, VF_REJECT_BACKOFF_SECS.length);
  const secs = VF_REJECT_BACKOFF_SECS[step - 1] ?? 60;
  const reason = e.message ?? e.code;
  return {
    state: { rejectBackoff: { step, until: e.at + secs * 1000 } },
    actions:
      step === prev
        ? []
        : [
            {
              type: "log",
              decision: "Waiting",
              why: `Order refused by SoDEX: ${reason}. Retrying in ${String(secs)}s.`,
            },
          ],
  };
}

/** Từ chối cần chờ: không phải post-only / chặn tự khớp, và không phải thiếu margin (engine pause, DEC-290). */
const needsBackoff = (e: Extract<StrategyEvent, { type: "orderReject" }>): boolean =>
  e.insufficientMargin !== true && !NO_BACKOFF_CODES.includes(e.code);

function onTimer(
  c: VolumeFarmConfig,
  s0: VolumeFarmState,
  ctx: StepContext,
  e: Extract<StrategyEvent, { type: "timer" }>,
): StepResult<VolumeFarmState> {
  const at = e.at;
  const snap = e.market?.market === c.market ? e.market : undefined;
  const s = snap === undefined ? s0 : mergeRestBook(s0, snap, at);
  switch (s.phase) {
    case "entering": {
      if (s.entry === null || at - s.entry.placedAt < FARM_TIMING.entryFillMs) return none(s);
      const open = !dust(s, ctx, c.market);
      return {
        actions: [{ type: "cancel", clOrdID: s.entry.id }],
        state: {
          ...s,
          phase: open ? "open" : "idle",
          entry: null,
          unfilled: open ? 0 : s.unfilled + 1,
        },
      };
    }
    case "open":
      return watchOpen(c, s, ctx, at);
    case "exiting": {
      if (s.exit === null) return placeExit(c, s, ctx, at, false);
      if (at - s.exit.placedAt < FARM_TIMING.exitFillMs) return none(s);
      // Huỷ lượt này, đặt lại ở nhịp sau (không huỷ và đặt trong cùng một bước, như apex).
      return {
        actions: [{ type: "cancel", clOrdID: s.exit.id }],
        state: { ...s, exit: null, exitUnfilled: s.exitUnfilled + 1 },
      };
    }
    case "idle": {
      const g = guards(c, s, ctx);
      if (g !== null) return g;
      if (!dust(s, ctx, c.market)) {
        // Vị thế còn lại (ví dụ fill đến muộn sau khi huỷ lệnh vào): theo dõi như một lượt đang mở.
        return none({
          ...s,
          phase: "open",
          openedAt: s.openedAt ?? at,
          holdUntil: s.holdUntil ?? at,
        });
      }
      return snap === undefined ? none(s) : tryEnter(c, s, ctx, at, snap.candles);
    }
    case "halted":
      return none(s);
  }
}

function onFill(
  c: VolumeFarmConfig,
  s: VolumeFarmState,
  ctx: StepContext,
  e: Extract<StrategyEvent, { type: "fill" }>,
): StepResult<VolumeFarmState> {
  const o = s.orders[e.clOrdID];
  if (o === undefined) return none(s);
  const before = s.ledger;
  const ledger = applyFill(before, o.side, e.price, e.quantity, e.fee);
  const notional = dec(e.price).mul(e.quantity);
  let state: VolumeFarmState = { ...s, ledger, volume: dec(s.volume).add(notional).toString() };
  if (o.kind === "entry") {
    const first = state.openedAt === null;
    state = {
      ...state,
      phase: state.phase === "exiting" ? "exiting" : "open",
      openedAt: state.openedAt ?? e.at,
      holdUntil: first ? e.at + (state.holdSecs ?? c.minHoldSecs) * 1000 : state.holdUntil,
      unfilled: 0,
      marketRejects: 0,
      rejectBackoff: null,
      ...(first
        ? {
            openRealized: before.realized,
            openFees: before.fees,
            entryTaker: state.entry?.taker === true,
          }
        : {}),
    };
    if (dust(state, ctx, c.market)) return none(state);
    // Lệnh market khớp hết ngay: không còn gì để huỷ.
    if (state.entry?.taker === true) state = { ...state, entry: null };
    // Có vị thế: đặt stop loss trên SoDEX ngay (DEC-118).
    return syncXstop(c, state, ctx, e.at);
  }
  // Fill của lệnh thoát, hoặc stop loss trên SoDEX đã kích hoạt.
  if (o.kind === "stop")
    state = {
      ...state,
      exitReason: s.exitReason ?? `Stop loss on SoDEX at ${s.xstop?.price ?? e.price}`,
    };
  if (!dust(state, ctx, c.market)) return none(state);
  // Đã đóng hết: huỷ lệnh còn lại của lượt (lệnh thoát của bot hoặc stop trên sàn).
  const leftovers: StrategyAction[] = [
    // Stop trên sàn: SoDEX tự huỷ khi vị thế đóng; chỉ nhớ lại để lượt sau kiểm tra (DEC-119).
    ...(o.kind === "stop" && s.exit !== null
      ? [{ type: "cancel" as const, clOrdID: s.exit.id }]
      : []),
  ];
  const closedWhy = state.exitReason ?? "Exit filled";
  const tick = ctx.rules[c.market]?.tickSize;
  const closedEntry = tick === undefined ? before.avgCost : fmtPrice(dec(before.avgCost), tick);
  const positionSide: "long" | "short" = dec(before.position).gt(0) ? "long" : "short";
  // Lãi giá của lượt (trước phí) và lãi ròng (sau phí). Win rate đếm theo lãi giá (DEC-129): với bot khối lượng,
  // phí gần như luôn làm lượt lỗ ròng, nên win rate sau phí không cho biết hướng vào lệnh đúng hay sai.
  const pricePnl = dec(ledger.realized).sub(state.openRealized);
  const tradePnl = pricePnl.sub(dec(ledger.fees).sub(state.openFees));
  const entryNotional = dec(before.position).abs().mul(before.avgCost);
  const exposure = dec(s.netExposure).add(
    positionSide === "long" ? entryNotional : entryNotional.neg(),
  );
  state = {
    ...state,
    phase: "idle",
    entry: null,
    exit: null,
    openedAt: null,
    holdUntil: null,
    holdSecs: null,
    exitUnfilled: 0,
    exitForce: false,
    cooldownUntil: e.at + c.cooldownSecs * 1000,
    lastSide: positionSide,
    netExposure: exposure.toString(),
    trades: s.trades + 1,
    wins: s.wins + (pricePnl.gt(0) ? 1 : 0),
    entryTaker: false,
    breakEven: false,
    stopLevel: 0,
    peak: null,
    stopLogged: 0,
    xstop: null,
    xstopOff: false,
    staleXstop: o.kind === "stop" ? null : (s.xstop?.id ?? null),
  };
  const actions: StrategyAction[] = [
    ...leftovers,
    {
      type: "log",
      decision: `Closed ${positionSide}`,
      why: `${closedWhy}; entry ${closedEntry} → exit ${e.price}; price PnL ${pricePnl.toDecimalPlaces(4).toString()}, net ${tradePnl.toDecimalPlaces(4).toString()} USDC after fees.`,
    },
  ];
  const done: StepResult<VolumeFarmState> = { actions, state: { ...state, exitReason: null } };
  const g = guards(c, done.state, ctx);
  return g === null ? done : { actions: [...done.actions, ...g.actions], state: g.state };
}

export function stepVolumeFarm(
  c: VolumeFarmConfig,
  s: VolumeFarmState,
  e: StrategyEvent,
  ctx: StepContext,
): StepResult<VolumeFarmState> {
  if (s.phase === "halted" && e.type !== "fill") return none(s);
  switch (e.type) {
    case "tick": {
      if (e.market !== c.market) return none(s);
      const state = { ...s, lastPrice: e.price };
      if (state.phase !== "open") return none(state);
      return watchOpen(c, state, ctx, e.at);
    }
    case "timer":
      return onTimer(c, s, ctx, e);
    case "fill":
      return onFill(c, s, ctx, e);
    case "orderReject": {
      if (s.entry?.id === e.clOrdID) {
        const open = !dust(s, ctx, c.market);
        // Lệnh vào market bị từ chối (thiếu margin…): không gửi lại mãi; đủ ngưỡng thì pause để người dùng xem
        // (DEC-117 bật lại cho chế độ taker, DEC-259).
        if (s.entry.taker && !open) {
          const n = (s.marketRejects ?? 0) + 1;
          // Pause sau VF_MARKET_REJECTS lần (DEC-259) đi trước việc chờ.
          if (n >= VF_MARKET_REJECTS)
            return {
              actions: [
                {
                  type: "log",
                  decision: "Market entries rejected",
                  why: `SoDEX rejected ${String(n)} market entries in a row (${e.code}). Check your margin on SoDEX, then resume the bot.`,
                },
                { type: "pause", reason: ReasonCode.orderRejected },
              ],
              state: {
                ...s,
                phase: "idle",
                entry: null,
                unfilled: s.unfilled + 1,
                marketRejects: 0,
                rejectBackoff: null,
              },
            };
          const wait = needsBackoff(e) ? backoff(s, e) : { state: {}, actions: [] };
          return {
            actions: wait.actions,
            state: {
              ...s,
              ...wait.state,
              phase: "idle",
              entry: null,
              unfilled: s.unfilled + 1,
              marketRejects: n,
            },
          };
        }
        // Post-only bị từ chối vì sẽ khớp ngay (giá đã chạy): coi như một lần không khớp, lượt sau đặt lại ngay.
        // Lý do khác (không phải thiếu margin): chờ theo nấc trước lần vào kế tiếp (DEC-TBD-vb-reject-backoff).
        const wait = !open && needsBackoff(e) ? backoff(s, e) : { state: {}, actions: [] };
        return {
          actions: wait.actions,
          state: {
            ...s,
            ...wait.state,
            phase: open ? "open" : "idle",
            entry: null,
            unfilled: open ? 0 : s.unfilled + 1,
          },
        };
      }
      if (s.exit?.id === e.clOrdID)
        return none({ ...s, exit: null, exitUnfilled: s.exitUnfilled + 1 });
      if (s.xstop?.id === e.clOrdID) {
        // Stop trên sàn bị từ chối (đặt hoặc dời): huỷ bản cũ nếu còn, bot tự giữ SL như trước (DEC-118).
        const unsupported = e.code === "PAPER_NO_STOP";
        return {
          actions: [
            { type: "cancel", clOrdID: e.clOrdID },
            ...(unsupported || s.xstopUnsupported === true
              ? []
              : [
                  {
                    type: "log" as const,
                    decision: "Stop loss on SoDEX not set",
                    why: `SoDEX rejected it (code ${e.code}). The bot keeps watching its own stop loss for this trade.`,
                  },
                ]),
          ],
          state: {
            ...s,
            xstop: null,
            xstopOff: true,
            ...(unsupported ? { xstopUnsupported: true } : {}),
          },
        };
      }
      return none(s);
    }
    case "fundingPaid":
      return none({
        ...s,
        ledger: { ...s.ledger, funding: dec(s.ledger.funding).add(e.amount).toString() },
      });
    case "orderDone":
      // Stop trên sàn hết hiệu lực khi vị thế còn mở (SoDEX tự huỷ…): không đặt lại mãi, bot tự giữ SL.
      if (s.xstop?.id === e.clOrdID && !dust(s, ctx, c.market))
        return none({ ...s, xstop: null, xstopOff: true });
      return none(s);
    case "orderAck":
      // SoDEX nhận lệnh vào: hết chờ (DEC-TBD-vb-reject-backoff).
      if (s.entry?.id === e.clOrdID && s.rejectBackoff != null)
        return none({ ...s, rejectBackoff: null });
      return none(s);
    case "book":
      return onLiveBook(c, s, e);
    case "fundingRate":
    case "marginRatio":
    case "positionSync":
    case "fair":
    case "leaderFill":
    case "leaderPosition":
    case "resumed":
      return none(s);
  }
}

export const volumeFarm: StrategyModule<VolumeFarmConfig, VolumeFarmState> = {
  initialState: initial,
  step: stepVolumeFarm,
};
