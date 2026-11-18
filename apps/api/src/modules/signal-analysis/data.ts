import { MARKET_HOURS_MAX_MISSING_PRICE } from "@drift/shared";
import { sql } from "drizzle-orm";

import {
  D0,
  dec,
  Decimal,
  marksAt,
  perM,
  positionsAt,
  rowsOf,
  str,
  type BotInfo,
  type Exec,
  type Window,
} from "./common";

// Tập fill của một kỳ cho Signal Analysis: mọi fill của bot tiền thật của một chiến lược (index fills_filled_at_idx),
// kèm giá tham chiếu cho markout, theo cách của Market hours (DEC-283):
//   - 1 / 2 / 5 phút: close của nến 1 phút chứa thời điểm fill + 60 / 120 / 300 s (candles_1m, khoá (market, ts)); nến
//     chưa đóng thì không dùng.
//   - lúc fill / 10 s / 30 s: mid SoDEX theo giây (`mid_1s`, chỉ market có bot Market Making, giữ 48 giờ); không có → null.
// Không có giá → null ("Not available"), không bao giờ 0.

export interface FillRow {
  id: string;
  orderId: string;
  /** Epoch ms. */
  at: number;
  botId: string;
  side: "buy" | "sell";
  market: string;
  price: string;
  size: string;
  /** Đã gồm builder fee. */
  fee: string;
  builderFee: string | null;
  maker: boolean | null;
  tag: string;
  reduceOnly: boolean;
  type: "limit" | "market";
  tif: string;
  createdAt: number;
  clOrdId: string;
  context: unknown;
  m0: string | null;
  m10: string | null;
  m30: string | null;
  r60: string | null;
  r120: string | null;
  r300: string | null;
  /** Chỉ Volume Builder: close nến 1 phút đã đóng trước lúc đặt lệnh, và 1 / 3 / 5 phút trước đó. */
  base: string | null;
  b1: string | null;
  b3: string | null;
  b5: string | null;
}

export interface FillSet {
  window: Window;
  bots: BotInfo[];
  fills: FillRow[];
  /** Giá cuối kỳ / đầu kỳ của mỗi market (nến 1 phút trong 1 giờ). */
  markEnd: Map<string, string>;
  markStart: Map<string, string>;
  /** Vị thế của mỗi bot lúc đầu kỳ. */
  posStart: Map<string, Decimal>;
}

export async function loadFills(
  q: Exec,
  strategy: BotInfo["strategy"],
  w: Window,
  bots: BotInfo[],
): Promise<FillSet> {
  const vb = strategy === "volume_farm";
  const moveCols = vb
    ? sql`, cb.close::text as base, k1.close::text as b1, k3.close::text as b3, k5.close::text as b5`
    : sql`, null as base, null as b1, null as b3, null as b5`;
  const moveJoins = vb
    ? sql`
      left join candles_1m cb on cb.market = o.market and cb.ts = date_trunc('minute', o.created_at) - interval '1 minute'
      left join candles_1m k1 on k1.market = o.market and k1.ts = date_trunc('minute', o.created_at) - interval '2 minutes'
      left join candles_1m k3 on k3.market = o.market and k3.ts = date_trunc('minute', o.created_at) - interval '4 minutes'
      left join candles_1m k5 on k5.market = o.market and k5.ts = date_trunc('minute', o.created_at) - interval '6 minutes'`
    : sql``;
  const candle = (alias: string, secs: number) =>
    sql.raw(
      `left join candles_1m ${alias} on ${alias}.market = o.market and ${alias}.ts = date_trunc('minute', f.filled_at + interval '${String(secs)} seconds') and ${alias}.ts + interval '1 minute' <= `,
    );
  const mid = (alias: string, secs: number) =>
    sql.raw(
      `left join mid_1s ${alias} on ${alias}.market = o.market and ${alias}.ts = date_trunc('second', f.filled_at + interval '${String(secs)} seconds')`,
    );
  const r = await q.execute(sql`
    select f.id::text as id, o.id::text as "orderId", (extract(epoch from f.filled_at) * 1000)::float8 as at,
           o.bot_id::text as "botId", o.side, o.market, f.price::text as price, f.size::text as size,
           f.fee::text as fee, f.builder_fee::text as "builderFee", f.is_maker as maker, o.tag,
           o.reduce_only as "reduceOnly", o.type, o.time_in_force as tif,
           (extract(epoch from o.created_at) * 1000)::float8 as "createdAt", o.cl_ord_id as "clOrdId", o.context,
           m0.mid::text as m0, m10.mid::text as m10, m30.mid::text as m30,
           c1.close::text as r60, c2.close::text as r120, c5.close::text as r300 ${moveCols}
      from fills f
      join orders o on o.id = f.order_id
      join bots b on b.id = o.bot_id
      ${mid("m0", 0)}
      ${mid("m10", 10)}
      ${mid("m30", 30)}
      ${candle("c1", 60)}${w.to}::timestamptz
      ${candle("c2", 120)}${w.to}::timestamptz
      ${candle("c5", 300)}${w.to}::timestamptz
      ${moveJoins}
      where f.filled_at >= ${w.from} and f.filled_at < ${w.to}
        and b.mode = 'live' and b.strategy = ${strategy}
      order by f.filled_at, f.id`);
  const fills = rowsOf<FillRow>(r);
  const markets = [...new Set(fills.map((f) => f.market))];
  const botIds = [...new Set(fills.map((f) => f.botId))];
  // Tuần tự: cùng một transaction (một kết nối) không chạy song song.
  const markEnd = await marksAt(q, markets, w.to);
  const markStart = await marksAt(q, markets, w.from);
  const [posStart] = await positionsAt(q, botIds, [w.from]);
  return {
    window: w,
    bots,
    fills,
    markEnd,
    markStart,
    posStart: posStart ?? new Map<string, Decimal>(),
  };
}

export const dirOf = (side: "buy" | "sell"): 1 | -1 => (side === "buy" ? 1 : -1);

/**
 * Cộng dồn chi phí của một nhóm fill (DEC-283 / DEC-296, cùng cách chia ở cả ba tab). Với mỗi fill k (q = chiều × size):
 *   kết quả giá đến cuối kỳ = q × (giá cuối kỳ − giá khớp) = markout (q × (giá 1 phút − giá khớp)) + tồn kho (phần còn lại).
 * Net cost = Σ phí − Σ kết quả giá (− vị thế mang sang × (giá cuối − giá đầu) khi `carried`), dương = tốn. Markout chỉ
 * tính trên fill có giá 1 phút, chia cho volume của các fill đó; thiếu giá cho hơn 20% volume → null (như Market hours).
 */
export class CostAcc {
  fills = 0;
  volume = D0;
  fees = D0;
  builder = D0;
  pricedVolume = D0;
  markout = D0;
  readonly legs = new Map<string, { qty: Decimal; cash: Decimal }>();
  readonly bots = new Set<string>();

  add(f: FillRow): void {
    const p = dec(f.price);
    const s = dec(f.size);
    const n = p.mul(s);
    const d = dirOf(f.side);
    this.fills += 1;
    this.volume = this.volume.add(n);
    this.fees = this.fees.add(dec(f.fee));
    if (f.builderFee !== null) this.builder = this.builder.add(dec(f.builderFee));
    if (f.r60 !== null) {
      this.pricedVolume = this.pricedVolume.add(n);
      this.markout = this.markout.add(dec(f.r60).sub(p).mul(s).mul(d));
    }
    const leg = this.legs.get(f.market) ?? { qty: D0, cash: D0 };
    this.legs.set(f.market, {
      qty: leg.qty.add(s.mul(d)),
      cash: leg.cash.add(n.mul(d)),
    });
    this.bots.add(f.botId);
  }

  /**
   * `carried` = cộng phần vị thế đầu kỳ của các bot trong nhóm (chỉ nhóm theo bot: strategy, market, bot, account,
   * tổng). Nhóm theo thời gian (ngày, giờ) không cộng phần này.
   */
  result(
    set: Pick<FillSet, "markEnd" | "markStart" | "posStart">,
    botMarket: Map<string, string>,
    carried: boolean,
  ) {
    const fees = this.fees;
    let price: Decimal | null = D0;
    for (const [market, leg] of this.legs) {
      const m = set.markEnd.get(market);
      if (m === undefined) {
        price = null;
        break;
      }
      price = price.add(dec(m).mul(leg.qty).sub(leg.cash));
    }
    if (carried && price !== null) {
      for (const bot of this.bots) {
        const pos = set.posStart.get(bot) ?? D0;
        if (pos.isZero()) continue;
        const market = botMarket.get(bot) ?? "";
        const a = set.markStart.get(market);
        const b = set.markEnd.get(market);
        if (a === undefined || b === undefined) {
          price = null;
          break;
        }
        price = price.add(pos.mul(dec(b).sub(dec(a))));
      }
    }
    const missing = this.volume.isZero()
      ? new Decimal(1)
      : this.volume.sub(this.pricedVolume).div(this.volume);
    const markoutPerM =
      this.pricedVolume.gt(0) && missing.lte(MARKET_HOURS_MAX_MISSING_PRICE)
        ? this.markout.neg().div(this.pricedVolume).mul(1_000_000)
        : null;
    const netUsd = price === null ? null : fees.sub(price);
    const net = perM(netUsd, this.volume);
    const feesPerM = perM(fees, this.volume);
    return {
      fills: this.fills,
      volume: this.volume,
      fees: feesPerM,
      sodexFees: perM(fees.sub(this.builder), this.volume),
      builderFees: perM(this.builder, this.volume),
      markout: markoutPerM,
      inventory:
        net === null || markoutPerM === null || feesPerM === null
          ? null
          : net.sub(feesPerM).sub(markoutPerM),
      net,
      netUsd,
    };
  }
}

export type CostResult = ReturnType<CostAcc["result"]>;

export const costStrings = (c: CostResult) => ({
  fills: c.fills,
  volume: str(c.volume) ?? "0",
  fees: str(c.fees),
  sodexFees: str(c.sodexFees),
  builderFees: str(c.builderFees),
  markout: str(c.markout),
  inventory: str(c.inventory),
  net: str(c.net),
  netUsd: str(c.netUsd),
});

/**
 * Net cost / $1M của kỳ trước (cùng độ dài) theo bot: tổng trong SQL (không kéo từng fill), vị thế đầu kỳ trước và giá
 * đầu / cuối kỳ trước. Bot không có fill kỳ trước → không có khoá.
 */
export async function previousByBot(
  q: Exec,
  strategies: readonly BotInfo["strategy"][],
  w: Window,
): Promise<{
  legs: Map<
    string,
    { market: string; volume: Decimal; fees: Decimal; qty: Decimal; cash: Decimal }
  >;
  markEnd: Map<string, string>;
  markStart: Map<string, string>;
  posStart: Map<string, Decimal>;
}> {
  const r = await q.execute(sql`
    select o.bot_id::text as bot, o.market,
           sum(f.price * f.size)::text as volume, sum(f.fee)::text as fees,
           sum(case when o.side = 'buy' then f.size else -f.size end)::text as qty,
           sum(case when o.side = 'buy' then f.price * f.size else -(f.price * f.size) end)::text as cash
      from fills f
      join orders o on o.id = f.order_id
      join bots b on b.id = o.bot_id
      where f.filled_at >= ${w.from} and f.filled_at < ${w.to}
        and b.mode = 'live' and b.strategy in (${sql.join(
          strategies.map((s) => sql`${s}`),
          sql`, `,
        )})
      group by o.bot_id, o.market`);
  const rows = rowsOf<{
    bot: string;
    market: string;
    volume: string;
    fees: string;
    qty: string;
    cash: string;
  }>(r);
  const legs = new Map(
    rows.map((x) => [
      x.bot,
      {
        market: x.market,
        volume: dec(x.volume),
        fees: dec(x.fees),
        qty: dec(x.qty),
        cash: dec(x.cash),
      },
    ]),
  );
  const markets = [...new Set(rows.map((x) => x.market))];
  const markEnd = await marksAt(q, markets, w.to);
  const markStart = await marksAt(q, markets, w.from);
  const [posStart] = await positionsAt(q, [...legs.keys()], [w.from]);
  return { legs, markEnd, markStart, posStart: posStart ?? new Map<string, Decimal>() };
}

/** Net cost / $1M kỳ trước của một tập bot; bot thiếu giá → null; không có volume → null. */
export function previousNet(
  prev: Awaited<ReturnType<typeof previousByBot>>,
  botIds: Iterable<string>,
): Decimal | null {
  let volume = D0;
  let net: Decimal | null = D0;
  for (const bot of botIds) {
    const l = prev.legs.get(bot);
    if (l === undefined) continue;
    volume = volume.add(l.volume);
    if (net === null) continue;
    const end = prev.markEnd.get(l.market);
    const pos = prev.posStart.get(bot) ?? D0;
    const start = prev.markStart.get(l.market);
    if (end === undefined || (!pos.isZero() && start === undefined)) {
      net = null;
      continue;
    }
    const price = dec(end)
      .mul(l.qty)
      .sub(l.cash)
      .add(pos.isZero() ? D0 : pos.mul(dec(end).sub(dec(start ?? "0"))));
    net = net.add(l.fees.sub(price));
  }
  return net === null ? null : perM(net, volume);
}
