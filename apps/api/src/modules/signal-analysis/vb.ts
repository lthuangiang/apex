import {
  AppError,
  ErrorCode,
  SIGNAL_MIN_GROUP,
  SIGNAL_PAGE_SIZE,
  signalVbEntriesQuerySchema,
  signalVbQuerySchema,
  VB_BREAKDOWNS,
  SIGNAL_VB_HORIZONS,
  VB_MOVE_BUCKETS,
  type SignalHiddenLead,
  type SignalSuggestion,
  type SignalVbEntriesPage,
  type SignalVbQuery,
  type SignalVbView,
  type VbBreakdown,
  type VbEntry,
  type VbEntryDetail,
  type VbExitReason,
  type VbRegime,
  type VbRow,
} from "@drift/shared";
import { vbSignalSnapshotSchema, type VbSignalSnapshot } from "@drift/shared/vb-signal";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { parseOrThrow } from "../../lib/http";

import { botFacets } from "./all";
import {
  bpOf,
  D0,
  dec,
  Decimal,
  inList,
  isThin,
  localClock,
  mean,
  negPct,
  perM,
  quantileOf,
  r2,
  readOnly,
  rowsOf,
  str,
  team,
  type BotInfo,
  type SignalDeps,
} from "./common";
import type { FillRow, FillSet } from "./data";
import { extraSet, fillSet } from "./sets";
import { timelineOf } from "./timeline";

// Tab Volume Builder (thiết kế #222 trong khung #231): mỗi lượt vào (vào + ra) của bot Volume Builder tiền thật.
// bp tính trên một vòng theo notional lệnh vào, + = có lợi cho lệnh vào. Snapshot tín hiệu (`bot_events.payload.signal`,
// DEC-311) chỉ có từ v2.11.0: lượt cũ hơn vẫn có giá / phí / markout / "move before" (từ nến 1 phút), còn các phần theo
// tín hiệu là "Not available".
// "Opposite side" (what-if, giả định ghi trên trang): cùng giờ vào và thời gian giữ, post-only ở phía bên kia sổ lúc vào
// và lúc ra (cách một spread lúc vào), giả sử đã khớp: trước phí = −(trước phí thật) + 2 × spread lúc vào; phí như lượt
// thật; markout = −markout thật + spread. Không có spread lúc vào → Not available.

const TAG = /^vf:(\d+):(in|out|sl)/;
/** Trọng số các phần của điểm tín hiệu (DEC-80), chỉ để chọn phần "đóng góp nhiều nhất". */
const PART_WEIGHTS = { momentum: 0.3, wick: 0.25, volume: 0.2, book: 0.1 } as const;
type Lead = keyof typeof PART_WEIGHTS;
/** Ngưỡng "đã chạy nhanh" của gợi ý 1 và dấu ▲ trong danh sách. */
const FAST_MOVE_BP = 4;

export interface Trade {
  id: string;
  botId: string;
  botName: string;
  market: string;
  side: "long" | "short";
  ins: FillRow[];
  outs: FillRow[];
  entryAt: number;
  exitAt: number;
  orderAt: number;
  entryPrice: Decimal;
  exitPrice: Decimal;
  qty: Decimal;
  notional: Decimal;
  volume: Decimal;
  gross: Decimal;
  fees: Decimal;
  builder: Decimal;
  netUsd: Decimal;
  signal: VbSignalSnapshot | null;
  exit: VbExitReason | null;
  regime: VbRegime | null;
  entryType: "signal" | "balance" | null;
  score: number | null;
  lead: Lead | null;
  move: [number | null, number | null, number | null];
  markouts: (number | null)[];
  beforeFees: number;
  feesBp: number;
  sodexBp: number;
  builderBp: number;
  net: number;
  opposite: number | null;
  oppositeNet: number | null;
  oppositeMarkouts: (number | null)[];
}

const REGIME: Record<VbSignalSnapshot["regime"], VbRegime> = {
  SIDEWAY: "sideways",
  TREND_UP: "up",
  TREND_DOWN: "down",
  HIGH_VOLATILITY: "volatile",
  UNKNOWN: "unclear",
};

/** Lý do thoát từ câu "Closed …" của bot (đầu câu `why`, STRATEGIES.md S10). */
export function exitReasonOf(why: string | null, bySodexStop: boolean): VbExitReason | null {
  if (bySodexStop) return "stopOnSodex";
  if (why === null) return null;
  if (why.startsWith("Stop loss on SoDEX")) return "stopOnSodex";
  if (why.startsWith("Stop loss")) return "stopLoss";
  if (why.startsWith("Take profit")) return "takeProfit";
  if (why.startsWith("Max hold")) return "maxHold";
  if (why.startsWith("Early profit")) return "earlyProfit";
  if (why.startsWith("Hold time")) return "hold";
  return "other";
}

/** Phần của điểm đóng góp nhiều nhất theo hướng tín hiệu; không phần nào cùng hướng → null. */
export function leadOf(s: VbSignalSnapshot): Lead | null {
  const sign = s.direction === "long" ? 1 : -1;
  const c = s.components;
  const parts: [Lead, number][] = [
    ["momentum", PART_WEIGHTS.momentum * (c.candleMomentum - 0.5) * sign],
    ["wick", PART_WEIGHTS.wick * (c.wickRejection - 0.5) * sign],
    ["volume", PART_WEIGHTS.volume * (c.volumeAcceleration - 0.5) * sign],
    ["book", PART_WEIGHTS.book * (c.orderbookImbalance - 0.5) * sign],
  ];
  const top = parts.reduce((a, b) => (b[1] > a[1] ? b : a));
  return top[1] > 0 ? top[0] : null;
}

/** Điểm theo hướng tín hiệu: 50 = trung tính, 100 = mạnh nhất. */
export const scoreOf = (s: VbSignalSnapshot): number => 50 + Math.abs(s.score - 0.5) * 100;

interface VbEvents {
  /** clOrdID → snapshot. */
  signals: Map<string, VbSignalSnapshot>;
  /** Câu "Closed …" theo bot, theo thời gian. */
  closes: Map<string, { at: number; why: string | null }[]>;
}

async function loadEvents(
  deps: SignalDeps,
  set: FillSet,
  key: string,
  now: Date,
): Promise<VbEvents> {
  return extraSet(deps, `vbev|${key}`, now, () =>
    readOnly(deps.db, async (q) => {
      const botIds = [...new Set(set.fills.map((f) => f.botId))];
      const signals = new Map<string, VbSignalSnapshot>();
      const closes = new Map<string, { at: number; why: string | null }[]>();
      if (botIds.length === 0) return { signals, closes };
      const r = await q.execute(sql`
        select bot_id::text as bot, (extract(epoch from occurred_at) * 1000)::float8 as at, decision, why,
               case when decision like 'Enter %' then payload->'signal' end as signal
          from bot_events
          where bot_id in (${inList(botIds)})
            and occurred_at >= ${new Date(set.window.from.getTime() - 15 * 60_000)}
            and occurred_at < ${set.window.to}
            and (decision like 'Enter %' or decision like 'Closed %')
          order by occurred_at`);
      for (const e of rowsOf<{
        bot: string;
        at: number;
        decision: string;
        why: string | null;
        signal: unknown;
      }>(r)) {
        if (e.decision.startsWith("Closed ")) {
          const xs = closes.get(e.bot) ?? [];
          xs.push({ at: e.at, why: e.why });
          closes.set(e.bot, xs);
          continue;
        }
        if (e.signal === null || e.signal === undefined) continue;
        const s = vbSignalSnapshotSchema.safeParse(e.signal);
        if (s.success) signals.set(s.data.order.clOrdID, s.data);
      }
      return { signals, closes };
    }),
  );
}

/** Ghép fill thành lượt (fill vào của một lượt, rồi fill ra tới khi hết vị thế), như `buildTrades` nhưng bằng Decimal. */
export function buildVbTrades(set: FillSet, ev: VbEvents): Trade[] {
  const bots = new Map(set.bots.map((b) => [b.id, b]));
  const byBot = new Map<string, FillRow[]>();
  for (const f of set.fills) {
    const xs = byBot.get(f.botId) ?? [];
    xs.push(f);
    byBot.set(f.botId, xs);
  }
  const out: Trade[] = [];
  for (const [botId, fills] of byBot) {
    const bot = bots.get(botId);
    let cur = null as { cycle: number; ins: FillRow[]; outs: FillRow[] } | null;
    const close = () => {
      if (cur === null || cur.ins.length === 0 || cur.outs.length === 0) return;
      const t = tradeOf(bot, cur.ins, cur.outs, ev);
      if (t !== null) out.push(t);
    };
    for (const f of fills) {
      const m = TAG.exec(f.tag);
      if (m === null) continue;
      const cycle = Number(m[1]);
      const kind = m[2];
      if (kind === "in" && (cur?.cycle !== cycle || cur.outs.length > 0)) {
        close();
        cur = { cycle, ins: [], outs: [] };
      }
      if (cur === null) continue;
      if (kind === "in") cur.ins.push(f);
      else cur.outs.push(f);
    }
    close();
  }
  return out.sort((a, b) => b.entryAt - a.entryAt);
}

const sumOf = (xs: readonly FillRow[], f: (x: FillRow) => Decimal) =>
  xs.reduce((s, x) => s.add(f(x)), D0);

function tradeOf(
  bot: BotInfo | undefined,
  ins: FillRow[],
  outs: FillRow[],
  ev: VbEvents,
): Trade | null {
  const first = ins[0];
  const last = outs.at(-1);
  if (first === undefined || last === undefined || bot === undefined) return null;
  const qIn = sumOf(ins, (f) => dec(f.size));
  const qOut = sumOf(outs, (f) => dec(f.size));
  if (qIn.isZero() || qOut.lt(qIn.mul(0.999))) return null;
  const entryPrice = sumOf(ins, (f) => dec(f.price).mul(dec(f.size))).div(qIn);
  const exitPrice = sumOf(outs, (f) => dec(f.price).mul(dec(f.size))).div(qOut);
  const long = first.side === "buy";
  const all = [...ins, ...outs];
  const fees = sumOf(all, (f) => dec(f.fee));
  const builder = sumOf(all, (f) => (f.builderFee === null ? D0 : dec(f.builderFee)));
  const notional = qIn.mul(entryPrice);
  const gross = (long ? exitPrice.sub(entryPrice) : entryPrice.sub(exitPrice)).mul(qIn);
  const bp = (v: Decimal) => v.div(notional).mul(10_000).toNumber();
  const signal =
    ev.signals.get(first.clOrdId) ??
    ins.map((f) => ev.signals.get(f.clOrdId)).find((x) => x !== undefined) ??
    null;
  const d = long ? 1 : -1;
  const closeEv = (ev.closes.get(bot.id) ?? []).find(
    (c) => c.at >= last.at - 5_000 && c.at <= last.at + 120_000,
  );
  const move = (k: 1 | 3 | 5, ref: string | null): number | null => {
    if (signal !== null) {
      const v =
        k === 1 ? signal.price.chg1mBps : k === 3 ? signal.price.chg3mBps : signal.price.chg5mBps;
      return v === null ? null : v * d;
    }
    return first.base === null ? null : bpOf(d, ref ?? "", first.base);
  };
  const markouts = [first.m10, first.m30, first.r60, first.r120, first.r300].map((ref) =>
    bpOf(d, first.price, ref),
  );
  const beforeFees = bp(gross);
  const feesBp = -bp(fees);
  const spread = signal?.spreadBps ?? null;
  const opposite = spread === null ? null : -beforeFees + 2 * spread;
  return {
    id: first.orderId,
    botId: bot.id,
    botName: bot.name,
    market: first.market,
    side: long ? "long" : "short",
    ins,
    outs,
    entryAt: first.at,
    exitAt: last.at,
    orderAt: first.createdAt,
    entryPrice,
    exitPrice,
    qty: qIn,
    notional,
    volume: notional.add(qOut.mul(exitPrice)),
    gross,
    fees,
    builder,
    netUsd: gross.sub(fees),
    signal,
    exit: exitReasonOf(
      closeEv?.why ?? null,
      outs.some((f) => f.tag.endsWith(":sl")),
    ),
    regime: signal === null ? null : REGIME[signal.regime],
    entryType: signal === null ? null : signal.balanced ? "balance" : "signal",
    score: signal === null || signal.balanced ? null : scoreOf(signal),
    lead: signal === null || signal.balanced ? null : leadOf(signal),
    // "Move before" từ nến: (close nến đã đóng trước lúc đặt − close k phút trước đó) ÷ close k phút trước.
    move: [move(1, first.b1), move(3, first.b3), move(5, first.b5)],
    markouts,
    beforeFees,
    feesBp,
    sodexBp: -bp(fees.sub(builder)),
    builderBp: -bp(builder),
    net: beforeFees + feesBp,
    opposite,
    oppositeNet: opposite === null ? null : opposite + feesBp,
    oppositeMarkouts: markouts.map((m) => (m === null || spread === null ? null : -m + spread)),
  };
}

function filterTrades(
  trades: readonly Trade[],
  q: SignalVbQuery,
  bots: Map<string, BotInfo>,
): Trade[] {
  return trades.filter((t) => {
    if (q.market !== undefined && t.market !== q.market) return false;
    if (q.botId !== undefined && t.botId !== q.botId) return false;
    if (q.regime !== undefined && t.regime !== q.regime) return false;
    if (q.entryType !== undefined && t.entryType !== q.entryType) return false;
    if (q.reversed !== undefined && t.signal?.reversed !== (q.reversed === "on")) return false;
    return bots.has(t.botId);
  });
}

async function tradesFor(deps: SignalDeps, range: SignalVbQuery["range"], now: Date) {
  const set = await fillSet(deps, "volume_farm", range, now);
  const ev = await loadEvents(deps, set, range, now);
  const trades = await extraSet(deps, `vbtrades|${range}`, now, () =>
    Promise.resolve(buildVbTrades(set, ev)),
  );
  return { set, trades, bots: new Map(set.bots.map((b) => [b.id, b])) };
}

// ── Tổng hợp ──────────────────────────────────────────────────────────────────────────────────────────────────────

function rowOf(key: string, ts: readonly Trade[], total: number): VbRow {
  const volume = ts.reduce((s, t) => s.add(t.volume), D0);
  const net = ts.reduce((s, t) => s.add(t.netUsd), D0);
  return {
    key,
    n: ts.length,
    sharePct: total === 0 ? null : r2((ts.length / total) * 100),
    moveBefore3: r2(mean(ts.map((t) => t.move[1]))),
    markout1m: r2(mean(ts.map((t) => t.markouts[2] ?? null))),
    beforeFees: r2(mean(ts.map((t) => t.beforeFees))),
    fees: r2(mean(ts.map((t) => t.feesBp))),
    net: r2(mean(ts.map((t) => t.net))),
    netPerM: str(perM(ts.length === 0 ? null : net, volume)),
    oppositeNet: r2(mean(ts.map((t) => t.oppositeNet))),
    thin: isThin(ts.length),
  };
}

const SCORE_BANDS = [55, 60, 65, 70] as const;
const scoreBand = (s: number): string => {
  const b = SCORE_BANDS.filter((x) => s >= x).at(-1);
  return b === undefined ? "50" : String(b);
};
const SIZE_BANDS = [250, 400, 550] as const;
const sizeBand = (usd: number): string => {
  const b = SIZE_BANDS.filter((x) => usd >= x).at(-1);
  return b === undefined ? "0" : String(b);
};
const ORDER: Record<VbBreakdown, readonly string[] | null> = {
  regime: ["up", "down", "sideways", "volatile", "unclear", "unknown"],
  score: ["50", "55", "60", "65", "70"],
  part: ["momentum", "wick", "volume", "book", "none"],
  exit: [
    "hold",
    "takeProfit",
    "earlyProfit",
    "maxHold",
    "stopLoss",
    "stopOnSodex",
    "other",
    "unknown",
  ],
  entryType: ["signal", "balance", "unknown"],
  hour: ["0", "4", "8", "12", "16", "20"],
  market: null,
  size: ["0", "250", "400", "550"],
};

function breakdownOf(ts: readonly Trade[], tz: string): SignalVbView["breakdown"] {
  const clock = localClock(tz);
  const signalOnly = ts.filter((t) => t.entryType === "signal");
  const keyOf: Record<VbBreakdown, (t: Trade) => string | null> = {
    regime: (t) => t.regime ?? "unknown",
    score: (t) => (t.score === null ? null : scoreBand(t.score)),
    part: (t) => (t.entryType === "signal" ? (t.lead ?? "none") : null),
    exit: (t) => t.exit ?? "unknown",
    entryType: (t) => t.entryType ?? "unknown",
    hour: (t) => String(Math.floor(clock(t.entryAt).hour / 4) * 4),
    market: (t) => t.market,
    size: (t) => sizeBand(t.notional.toNumber()),
  };
  const out = {} as SignalVbView["breakdown"];
  for (const by of VB_BREAKDOWNS) {
    const base = by === "score" || by === "part" ? signalOnly : ts;
    const groups = new Map<string, Trade[]>();
    for (const t of base) {
      const k = keyOf[by](t);
      if (k === null) continue;
      const xs = groups.get(k) ?? [];
      xs.push(t);
      groups.set(k, xs);
    }
    const order = ORDER[by] ?? [...groups.keys()].sort();
    out[by] = {
      rows: order
        .filter((k) => groups.has(k))
        .map((k) => rowOf(k, groups.get(k) ?? [], base.length)),
      total: rowOf(by === "score" || by === "part" ? "allSignal" : "all", base, base.length),
    };
  }
  return out;
}

function moveBuckets(ts: readonly Trade[], i: 0 | 1 | 2) {
  const keyOf = (m: number): (typeof VB_MOVE_BUCKETS)[number] =>
    m < 0 ? "against" : m < 2 ? "0-2" : m < 4 ? "2-4" : m < 6 ? "4-6" : "6+";
  return VB_MOVE_BUCKETS.map((key) => {
    const g = ts.filter((t) => {
      const m = t.move[i];
      return m !== null && keyOf(m) === key;
    });
    return {
      key,
      n: g.length,
      beforeFees: r2(mean(g.map((t) => t.beforeFees))),
      opposite: r2(mean(g.map((t) => t.opposite))),
      thin: isThin(g.length),
    };
  });
}

/** Gợi ý của tab VB (chỉ khi nhóm ≥ 30, cần duyệt, không bao giờ tự đổi bot). */
export function vbSuggestions(ts: readonly Trade[]): {
  suggestions: SignalSuggestion[];
  hidden: SignalHiddenLead[];
} {
  const suggestions: SignalSuggestion[] = [];
  const hidden: SignalHiddenLead[] = [];
  const ok = (n: number) => n >= SIGNAL_MIN_GROUP;
  const avg = (xs: readonly Trade[], f: (t: Trade) => number | null) => mean(xs.map(f));

  // 1. Vào sau khi giá đã chạy nhanh theo hướng tín hiệu.
  const known = ts.filter((t) => t.move[1] !== null);
  const fast = known.filter((t) => (t.move[1] ?? 0) >= FAST_MOVE_BP);
  const rest = known.filter((t) => (t.move[1] ?? 0) < FAST_MOVE_BP);
  if (ok(fast.length) && ok(rest.length)) {
    const a = avg(fast, (t) => t.beforeFees) ?? 0;
    const b = avg(rest, (t) => t.beforeFees) ?? 0;
    const lossAll = ts.reduce((s, t) => s + t.beforeFees, 0);
    const lossFast = fast.reduce((s, t) => s + t.beforeFees, 0);
    if (a < b && a < 0)
      suggestions.push({
        key: "fastMove",
        n: fast.length,
        values: {
          lost: r2(-a) ?? 0,
          more: r2(b - a) ?? 0,
          share: r2((fast.length / ts.length) * 100) ?? 0,
          count: fast.length,
          total: ts.length,
          timing: lossAll < 0 ? (r2((lossFast / lossAll) * 100) ?? 0) : 0,
        },
      });
  } else if (fast.length > 0) hidden.push({ key: "fastMove", n: fast.length });

  // 2. Giá tiếp tục chạy ngược sau khi khớp: chờ pullback.
  const m1 = ts.filter((t) => t.markouts[2] !== null);
  if (ok(m1.length)) {
    const m30 = avg(ts, (t) => t.markouts[1] ?? null);
    const m300 = avg(ts, (t) => t.markouts[4] ?? null);
    const behind = negPct(m1.map((t) => t.markouts[2] ?? null)) ?? 0;
    const last = m300 ?? avg(ts, (t) => t.markouts[2] ?? null);
    if (last !== null && last < 0 && behind > 50)
      suggestions.push({
        key: m30 === null ? "pullbackNoSeconds" : "pullback",
        n: m1.length,
        values: {
          m30: r2(m30) ?? 0,
          m300: r2(last) ?? 0,
          behind: r2(behind) ?? 0,
        },
      });
  } else if (m1.length > 0) hidden.push({ key: "pullback", n: m1.length });

  // 3. Phần "candle momentum" dẫn điểm.
  const sig = ts.filter((t) => t.entryType === "signal");
  const mom = sig.filter((t) => t.lead === "momentum");
  const other = sig.filter((t) => t.lead !== "momentum");
  if (ok(mom.length) && ok(other.length)) {
    const a = avg(mom, (t) => t.beforeFees) ?? 0;
    const b = avg(other, (t) => t.beforeFees) ?? 0;
    if (a < b && a < 0)
      suggestions.push({
        key: "momentum",
        n: sig.length,
        values: { lost: r2(-a) ?? 0, count: mom.length, other: r2(-b) ?? 0 },
      });
  } else if (mom.length > 0) hidden.push({ key: "momentum", n: mom.length });

  // 4. Lượt theo tín hiệu tệ hơn lượt cân long / short.
  const bal = ts.filter((t) => t.entryType === "balance");
  if (ok(sig.length) && ok(bal.length)) {
    const a = avg(sig, (t) => t.beforeFees) ?? 0;
    const b = avg(bal, (t) => t.beforeFees) ?? 0;
    const withOpp = ts.filter((t) => t.opposite !== null);
    const reverse =
      withOpp.length === 0 ? null : avg(withOpp, (t) => (t.opposite ?? 0) - t.beforeFees);
    const fees = avg(ts, (t) => t.feesBp) ?? 0;
    const oppNet = avg(withOpp, (t) => t.oppositeNet);
    if (a < b)
      suggestions.push({
        key:
          reverse !== null && reverse > 0 && oppNet !== null && oppNet < 0
            ? "signalVsBalance"
            : "signalVsBalanceShort",
        n: ts.length,
        values: {
          balance: r2(-b) ?? 0,
          signal: r2(-a) ?? 0,
          reverse: r2(reverse) ?? 0,
          fees: r2(-fees) ?? 0,
        },
      });
  } else if (bal.length > 0 || sig.length > 0)
    hidden.push({ key: "signalVsBalance", n: Math.min(sig.length, bal.length) });

  return { suggestions, hidden };
}

export async function signalVb(
  deps: SignalDeps,
  userId: string,
  query: unknown,
): Promise<SignalVbView> {
  await team(deps, userId);
  const q = parseOrThrow(signalVbQuerySchema, query);
  const now = deps.now();
  const { set, trades, bots } = await tradesFor(deps, q.range, now);
  const ts = filterTrades(trades, q, bots);
  const volume = ts.reduce((s, t) => s.add(t.volume), D0);
  const netUsd = ts.reduce((s, t) => s.add(t.netUsd), D0);
  const gross = ts.reduce((s, t) => s.add(t.gross), D0);
  const fees = ts.reduce((s, t) => s.add(t.fees), D0);
  const withOpp = ts.filter((t) => t.opposite !== null);
  const oppNetUsd = withOpp.reduce(
    (s, t) =>
      s.add(
        t.gross
          .neg()
          .add(t.notional.mul((t.signal?.spreadBps ?? 0) * 2).div(10_000))
          .sub(t.fees),
      ),
    D0,
  );
  const oppVolume = withOpp.reduce((s, t) => s.add(t.volume), D0);
  const none = ts.length === 0;
  const { suggestions, hidden } = vbSuggestions(ts);
  return {
    computedAt: now.toISOString(),
    range: q.range,
    tz: q.tz,
    from: set.window.from.toISOString(),
    to: set.window.to.toISOString(),
    bots: new Set(ts.map((t) => t.botId)).size,
    accounts: new Set(ts.map((t) => bots.get(t.botId)?.userId)).size,
    markets: [...new Set(set.fills.map((f) => f.market))].sort(),
    botList: botFacets(set.fills, bots),
    summary: {
      entries: ts.length,
      signal: ts.filter((t) => t.entryType === "signal").length,
      balance: ts.filter((t) => t.entryType === "balance").length,
      noSnapshot: ts.filter((t) => t.signal === null).length,
      volume: str(volume) ?? "0",
      beforeFees: r2(mean(ts.map((t) => t.beforeFees))),
      fees: r2(mean(ts.map((t) => t.feesBp))),
      sodexFees: r2(mean(ts.map((t) => t.sodexBp))),
      builderFees: r2(mean(ts.map((t) => t.builderBp))),
      net: r2(mean(ts.map((t) => t.net))),
      beforeFeesPerM: str(perM(none ? null : gross, volume)),
      feesPerM: str(perM(none ? null : fees.neg(), volume)),
      netPerM: str(perM(none ? null : netUsd, volume)),
      netUsd: none ? null : str(netUsd),
      opposite: r2(mean(withOpp.map((t) => t.opposite))),
      oppositeNet: r2(mean(withOpp.map((t) => t.oppositeNet))),
      oppositeNetPerM: str(perM(withOpp.length === 0 ? null : oppNetUsd, oppVolume)),
      oppositeN: withOpp.length,
    },
    suggestions,
    hidden,
    markout: {
      actual: SIGNAL_VB_HORIZONS.map((_, i) => {
        const xs = ts.map((t) => t.markouts[i] ?? null);
        return {
          n: xs.filter((x) => x !== null).length,
          mean: r2(mean(xs)),
          p25: r2(quantileOf(xs, 0.25)),
          p75: r2(quantileOf(xs, 0.75)),
          againstPct: r2(negPct(xs)),
        };
      }),
      opposite: SIGNAL_VB_HORIZONS.map((_, i) =>
        r2(mean(ts.map((t) => t.oppositeMarkouts[i] ?? null))),
      ),
    },
    moveBefore: { m1: moveBuckets(ts, 0), m3: moveBuckets(ts, 1), m5: moveBuckets(ts, 2) },
    breakdown: breakdownOf(ts, q.tz),
  };
}

export function entryOf(t: Trade): VbEntry {
  return {
    id: t.id,
    filledAt: new Date(t.entryAt).toISOString(),
    market: t.market,
    botId: t.botId,
    botName: t.botName,
    side: t.side,
    entryType: t.entryType,
    score: r2(t.score),
    moveBefore3: r2(t.move[1]),
    markout1m: r2(t.markouts[2]),
    exit: t.exit,
    beforeFees: r2(t.beforeFees),
    net: r2(t.net),
    oppositeNet: r2(t.oppositeNet),
  };
}

export async function signalVbEntries(
  deps: SignalDeps,
  userId: string,
  query: unknown,
): Promise<SignalVbEntriesPage> {
  await team(deps, userId);
  const q = parseOrThrow(signalVbEntriesQuerySchema, query);
  const { trades, bots } = await tradesFor(deps, q.range, deps.now());
  const ts = filterTrades(trades, q, bots);
  const sorted =
    q.sort === "worst"
      ? [...ts].sort((a, b) => a.net - b.net)
      : q.sort === "move"
        ? [...ts].sort((a, b) => desc(a.move[1], b.move[1]))
        : ts;
  const items = sorted.slice(q.offset, q.offset + SIGNAL_PAGE_SIZE).map(entryOf);
  const next = q.offset + SIGNAL_PAGE_SIZE;
  return { total: ts.length, items, nextOffset: next < ts.length ? next : null };
}

const idSchema = z.uuid();

export async function signalVbEntry(
  deps: SignalDeps,
  userId: string,
  id: string,
  query: unknown,
): Promise<VbEntryDetail> {
  await team(deps, userId);
  const q = parseOrThrow(signalVbQuerySchema, query);
  if (!idSchema.safeParse(id).success) throw new AppError(ErrorCode.notFound, "Entry not found.");
  const { trades, bots } = await tradesFor(deps, q.range, deps.now());
  const t = trades.find((x) => x.id === id);
  if (t === undefined) throw new AppError(ErrorCode.notFound, "Entry not found.");
  const ts = filterTrades(trades, q, bots);
  const extra = await readOnly(deps.db, async (x) => {
    const c = await x.execute(sql`
      select ts, high::text as h, low::text as l, close::text as c
        from candles_1m
        where market = ${t.market}
          and ts >= ${new Date(t.orderAt - 5 * 60_000)} and ts <= ${new Date(t.exitAt + 3 * 60_000)}
        order by ts
        limit 180`);
    const timeline = await timelineOf(x, t.botId, t.orderAt - 30_000, t.exitAt + 5_000, "vf:%");
    return { candles: rowsOf<{ ts: string | Date; h: string; l: string; c: string }>(c), timeline };
  });
  const long = t.side === "long";
  const held = extra.candles.filter((k) => {
    const at = new Date(k.ts).getTime();
    return at >= Math.floor(t.entryAt / 60_000) * 60_000 && at <= t.exitAt;
  });
  let mfe: number | null = null;
  let mae: number | null = null;
  if (held.length > 0) {
    const hi = Math.max(...held.map((k) => Number(k.h)));
    const lo = Math.min(...held.map((k) => Number(k.l)));
    const e = t.entryPrice.toNumber();
    mfe = Math.max(0, ((long ? hi - e : e - lo) / e) * 100);
    mae = Math.max(0, ((long ? e - lo : hi - e) / e) * 100);
  }
  const spread = t.signal?.spreadBps ?? null;
  const opp = (() => {
    if (spread === null) return null;
    const s = new Decimal(spread).div(10_000);
    // Phía ngược: vào ở phía bên kia sổ lúc vào, ra ở phía bên kia sổ lúc ra, cách một spread lúc vào.
    const entry = long ? t.entryPrice.mul(s.add(1)) : t.entryPrice.mul(new Decimal(1).sub(s));
    const exit = long ? t.exitPrice.mul(new Decimal(1).sub(s)) : t.exitPrice.mul(s.add(1));
    const pnl = (long ? entry.sub(exit) : exit.sub(entry)).mul(t.qty);
    const net = pnl.sub(t.fees);
    return {
      side: long ? ("short" as const) : ("long" as const),
      entry: str(entry, 8) ?? "0",
      exit: str(exit, 8) ?? "0",
      pricePnl: str(pnl, 4) ?? "0",
      fees: str(t.fees.neg(), 4) ?? "0",
      net: str(net, 4) ?? "0",
      netBp: r2(t.oppositeNet),
    };
  })();
  const sig = t.signal;
  return {
    entry: entryOf(t),
    entryPrice: str(t.entryPrice, 8) ?? "0",
    exitPrice: str(t.exitPrice, 8),
    exitAt: new Date(t.exitAt).toISOString(),
    orderAt: new Date(t.orderAt).toISOString(),
    heldSecs: Math.round((t.exitAt - t.entryAt) / 1000),
    notional: str(t.notional) ?? "0",
    pricePnl: str(t.gross, 4),
    fees: str(t.fees.neg(), 4) ?? "0",
    netPnl: str(t.netUsd, 4),
    pricePnlBp: r2(t.beforeFees),
    feesBp: r2(t.feesBp),
    mfePct: mfe === null ? null : Math.round(mfe * 1000) / 1000,
    maePct: mae === null ? null : Math.round(mae * 1000) / 1000,
    candles: extra.candles.map((k) => ({
      t: new Date(k.ts).toISOString(),
      h: k.h,
      l: k.l,
      c: k.c,
    })),
    timeline: extra.timeline,
    signal:
      sig === null
        ? null
        : {
            score: sig.balanced ? null : r2(scoreOf(sig)),
            regime: REGIME[sig.regime],
            spreadBp: r2(sig.spreadBps),
            parts: {
              momentum: Math.round(sig.components.candleMomentum * 100),
              wick: Math.round(sig.components.wickRejection * 100),
              volume: Math.round(sig.components.volumeAcceleration * 100),
              trade: Math.round(sig.components.tradePressure * 100),
              book: Math.round(sig.components.orderbookImbalance * 100),
            },
            lead: sig.balanced ? null : leadOf(sig),
            reversed: sig.reversed,
          },
    moveBefore: { m1: r2(t.move[0]), m3: r2(t.move[1]), m5: r2(t.move[2]) },
    moveBeforeAll: {
      m1: r2(mean(ts.map((x) => x.move[0]))),
      m3: r2(mean(ts.map((x) => x.move[1]))),
      m5: r2(mean(ts.map((x) => x.move[2]))),
    },
    markouts: t.markouts.map(r2),
    markoutsAll: SIGNAL_VB_HORIZONS.map((_, i) => r2(mean(ts.map((x) => x.markouts[i] ?? null)))),
    opposite: opp,
  };
}

/** Giảm dần, null cuối. */
export function desc(a: number | null, b: number | null): number {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return b - a;
}
