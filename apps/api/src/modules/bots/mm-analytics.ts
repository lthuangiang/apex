import { botVersions, candles1m, fills, orders } from "@drift/db";
import { MM_HORIZONS, type BotAnalytics, type MmAnalytics } from "@drift/shared";
import { and, asc, eq, gte, like, lte, sql } from "drizzle-orm";

import type { BotDeps } from "./service";

// Analytics của Market Making (DEC-144): theo từng lần khớp. Khớp bất lợi = giá đóng nến 1 phút sau 1 / 3 / 5 phút so
// với giá khớp, theo hướng có lợi cho lệnh vừa khớp (âm = giá chạy ngược). Nến 1 phút nên chỉ đo được từ 1 phút trở
// lên. Tách lệnh báo giá (bid / ask / buy / sell) khỏi lệnh đóng tồn kho (`:rc`), và theo công tắc Smart quoting.

const round = (v: number, dp = 4) => Math.round(v * 10 ** dp) / 10 ** dp;
const pct = (a: number, b: number) => (b > 0 ? round((a / b) * 100, 1) : null);
const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? null;
};

interface Fill {
  at: number;
  side: "buy" | "sell";
  tag: string;
  price: number;
  size: number;
  fee: number;
  builder: number;
  maker: boolean;
  restSecs: number | null;
  smart: boolean;
}

export async function mmAnalytics(
  deps: BotDeps,
  botId: string,
  market: string,
  from: number,
  now: number,
): Promise<{ mm: MmAnalytics; insights: BotAnalytics["insights"]; volume: number; fees: number }> {
  const db = deps.db;
  const versions = (
    await db
      .select({
        at: botVersions.appliedAt,
        created: botVersions.createdAt,
        config: botVersions.config,
      })
      .from(botVersions)
      .where(eq(botVersions.botId, botId))
      .orderBy(asc(botVersions.version))
  ).map((v) => ({
    at: (v.at ?? v.created).getTime(),
    smart: (v.config as { smartQuoting?: boolean }).smartQuoting === true,
  }));
  const smartAt = (t: number) =>
    [...versions].reverse().find((v) => v.at <= t + 1_000)?.smart ?? false;

  const rows = await db
    .select({
      at: fills.filledAt,
      side: orders.side,
      tag: orders.tag,
      price: fills.price,
      size: fills.size,
      fee: fills.fee,
      builder: fills.builderFee,
      maker: fills.isMaker,
      submitted: orders.submittedAt,
    })
    .from(fills)
    .innerJoin(orders, eq(orders.id, fills.orderId))
    .where(
      and(eq(orders.botId, botId), like(orders.tag, "vm:%"), gte(fills.filledAt, new Date(from))),
    )
    .orderBy(asc(fills.filledAt));
  const fs: Fill[] = rows.map((r) => ({
    at: r.at.getTime(),
    side: r.side,
    tag: r.tag,
    price: Number(r.price),
    size: Number(r.size),
    fee: Number(r.fee),
    builder: Number(r.builder ?? "0"),
    maker: r.maker === true,
    restSecs:
      r.submitted === null ? null : Math.max(0, (r.at.getTime() - r.submitted.getTime()) / 1000),
    smart: smartAt(r.at.getTime()),
  }));

  const candles = new Map<number, number>();
  const first = fs[0];
  const last = fs.at(-1);
  if (first !== undefined && last !== undefined) {
    const ks = await db
      .select({ ts: candles1m.ts, close: candles1m.close })
      .from(candles1m)
      .where(
        and(
          eq(candles1m.market, market),
          gte(candles1m.ts, new Date(Math.floor(first.at / 60_000) * 60_000)),
          lte(candles1m.ts, new Date(last.at + 6 * 60_000)),
        ),
      );
    for (const k of ks) candles.set(k.ts.getTime(), Number(k.close));
  }

  const isQuote = (f: Fill) => !f.tag.endsWith(":rc");
  const adverse = (xs: Fill[]) =>
    MM_HORIZONS.map((m) => {
      const moves: number[] = [];
      for (const f of xs) {
        const c = candles.get(Math.floor(f.at / 60_000) * 60_000 + m * 60_000);
        if (c === undefined) continue;
        moves.push(((c - f.price) / f.price) * 10_000 * (f.side === "buy" ? 1 : -1));
      }
      return {
        minutes: m,
        bp: moves.length === 0 ? null : round(moves.reduce((a, b) => a + b, 0) / moves.length, 2),
        againstPct: pct(moves.filter((x) => x < 0).length, moves.length),
      };
    });

  const quotes = fs.filter(isQuote);
  const volume = fs.reduce((n, f) => n + f.price * f.size, 0);
  const makerVol = fs.filter((f) => f.maker).reduce((n, f) => n + f.price * f.size, 0);
  const fees = fs.reduce((n, f) => n + f.fee, 0);
  const builder = fs.reduce((n, f) => n + f.builder, 0);

  // Tồn kho theo thời gian (USDC theo giá khớp), và % thời gian không giữ vị thế.
  let pos = 0;
  let maxAbs = 0;
  let flatMs = 0;
  let prevT = from;
  const series: { t: number; usd: number }[] = [];
  for (const f of fs) {
    if (Math.abs(pos) * f.price < 1) flatMs += f.at - prevT;
    prevT = f.at;
    pos += f.side === "buy" ? f.size : -f.size;
    const usd = round(pos * f.price, 2);
    maxAbs = Math.max(maxAbs, Math.abs(usd));
    series.push({ t: f.at, usd });
  }
  if (Math.abs(pos) * (last?.price ?? 0) < 1) flatMs += now - prevT;

  // Volume theo giờ (tối đa 48 điểm).
  const bucket = Math.max(60_000, Math.ceil((now - from) / 48 / 60_000) * 60_000);
  const vol = new Map<number, number>();
  for (const f of fs) {
    const k = from + Math.floor((f.at - from) / bucket) * bucket;
    vol.set(k, (vol.get(k) ?? 0) + f.price * f.size);
  }

  const [ord] = await db
    .select({
      placed: sql<number>`count(*)::int`,
      filled: sql<number>`count(*) filter (where ${orders.filledSize} > 0)::int`,
      rejected: sql<number>`count(*) filter (where ${orders.status} = 'rejected')::int`,
    })
    .from(orders)
    .where(
      and(eq(orders.botId, botId), like(orders.tag, "vm:%"), gte(orders.createdAt, new Date(from))),
    );

  const adv = adverse(quotes);
  const mm: MmAnalytics = {
    fills: fs.length,
    quoteFills: quotes.length,
    closeFills: fs.length - quotes.length,
    volume: round(volume, 2),
    makerPct: pct(makerVol, volume),
    fees: round(fees),
    builderFees: round(builder),
    feePerMillion: volume > 0 ? round((fees / volume) * 1e6, 1) : null,
    ordersPlaced: ord?.placed ?? 0,
    ordersFilled: ord?.filled ?? 0,
    fillRatePct: pct(ord?.filled ?? 0, ord?.placed ?? 0),
    rejected: ord?.rejected ?? 0,
    medianRestSecs: median(fs.flatMap((f) => (f.restSecs === null ? [] : [round(f.restSecs, 1)]))),
    adverse: adv,
    bySide: (["bid", "ask"] as const).map((side) => {
      const xs = quotes.filter((f) => (side === "bid" ? f.side === "buy" : f.side === "sell"));
      return { side, fills: xs.length, adverse: adverse(xs) };
    }),
    smart: [false, true]
      .map((on) => {
        const xs = quotes.filter((f) => f.smart === on);
        return { on, fills: xs.length, adverse: adverse(xs) };
      })
      .filter((g) => g.fills > 0),
    inventory: {
      series:
        series.length > 400
          ? series.filter((_, i) => i % Math.ceil(series.length / 400) === 0)
          : series,
      maxAbsUsd: round(maxAbs, 2),
      flatPct: now > from ? round((flatMs / (now - from)) * 100, 1) : null,
    },
    volumeSeries: [...vol.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([t, v]) => ({ t, volume: round(v, 2) })),
  };

  // Nhận xét tính thẳng từ số.
  const insights: BotAnalytics["insights"] = [];
  if (quotes.length > 0 && quotes.length < 50)
    insights.push({ key: "mmSmallSample", params: { n: quotes.length } });
  const a1 = adv[0];
  const feeBp = volume > 0 ? (fees / volume) * 10_000 : null;
  if (a1?.bp != null && a1.bp < 0 && feeBp !== null)
    insights.push({
      key: "mmAdverse",
      params: { bp: Math.abs(a1.bp), pct: a1.againstPct ?? 0, fee: round(feeBp, 2) },
    });
  const sides = mm.bySide.filter((s) => s.fills >= 20 && s.adverse[0]?.bp != null);
  if (sides.length === 2) {
    const [b, a] = sides;
    const gap = (b?.adverse[0]?.bp ?? 0) - (a?.adverse[0]?.bp ?? 0);
    if (Math.abs(gap) >= 1)
      insights.push({
        key: "mmSideWorse",
        params: { side: gap < 0 ? "bid" : "ask", gap: round(Math.abs(gap), 2) },
      });
  }
  const on = mm.smart.find((g) => g.on);
  const off = mm.smart.find((g) => !g.on);
  if (on !== undefined && off !== undefined && on.fills >= 30 && off.fills >= 30) {
    const d = (on.adverse[0]?.bp ?? 0) - (off.adverse[0]?.bp ?? 0);
    insights.push({
      key: d >= 0 ? "mmSmartBetter" : "mmSmartWorse",
      params: { bp: round(Math.abs(d), 2) },
    });
  }
  if (mm.fillRatePct !== null && mm.ordersPlaced >= 50 && mm.fillRatePct < 25)
    insights.push({ key: "lowFills", params: { pct: mm.fillRatePct } });
  return { mm, insights, volume: round(volume, 2), fees: round(fees) };
}
