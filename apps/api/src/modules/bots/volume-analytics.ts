import { botEvents, botVersions, fills, orders } from "@drift/db";
import { dec, Strategy, type VolumeAnalytics, type VolumePeriod } from "@drift/shared";
import { and, eq, gte, sql } from "drizzle-orm";

import { iso } from "../security/service";

import { ownBot, type BotDeps } from "./service";

// Bảng Volume của bot khối lượng (DEC-128): volume, phí, lãi / lỗ ròng theo kỳ, chia thành các khoảng đều nhau để vẽ
// biểu đồ. Nguồn: `fills` (volume, maker, chiều, phí, builder fee), `orders` (đã gửi / khớp / bị từ chối) và các dòng
// Decisions "Closed … net X USDC" (lãi ròng sau phí của từng lượt, kể cả funding đã ghi vào sổ cái).

const BUCKETS = 24;
const PERIOD_MS: Record<Exclude<VolumePeriod, "session" | "all">, number> = {
  h1: 3_600_000,
  h24: 86_400_000,
  d7: 7 * 86_400_000,
};
const NET_RE = "net (-?[0-9.]+) USDC";
const PRICE_RE = "price PnL (-?[0-9.]+)";
const ENTRY_RE = "entry ([0-9.]+) →";
const EXIT_RE = "→ exit ([0-9.]+)";

export async function volumeAnalytics(
  deps: BotDeps,
  userId: string,
  botId: string,
  period: VolumePeriod,
): Promise<VolumeAnalytics> {
  const b = await ownBot(deps.db, userId, botId);
  const now = deps.now();
  let from: Date;
  if (period === "session") {
    const [v] = await deps.db
      .select({ appliedAt: botVersions.appliedAt, createdAt: botVersions.createdAt })
      .from(botVersions)
      .where(eq(botVersions.id, b.activeVersionId ?? ""))
      .limit(1);
    from = v?.appliedAt ?? v?.createdAt ?? b.createdAt;
  } else if (period === "all") {
    from = b.createdAt;
  } else {
    from = new Date(now.getTime() - PERIOD_MS[period]);
  }
  const span = Math.max(60_000, now.getTime() - from.getTime());
  const bucketMs = Math.max(60_000, Math.ceil(span / BUCKETS / 60_000) * 60_000);
  const bucketOf = (col: unknown) =>
    sql<number>`floor((extract(epoch from ${col}) * 1000 - ${from.getTime()}) / ${bucketMs})::int`;

  const notional = sql`${fills.price} * ${fills.size}`;
  const fillRows = await deps.db
    .select({
      bucket: bucketOf(fills.filledAt),
      volume: sql<string>`coalesce(sum(${notional}), 0)::text`,
      maker: sql<string>`coalesce(sum(${notional}) filter (where ${fills.isMaker}), 0)::text`,
      buy: sql<string>`coalesce(sum(${notional}) filter (where ${orders.side} = 'buy'), 0)::text`,
      fees: sql<string>`coalesce(sum(${fills.fee}), 0)::text`,
      builder: sql<string>`coalesce(sum(${fills.builderFee}), 0)::text`,
    })
    .from(fills)
    .innerJoin(orders, eq(orders.id, fills.orderId))
    .where(and(eq(orders.botId, botId), gte(fills.filledAt, from)))
    .groupBy(sql`1`);

  const closeRows = await deps.db
    .select({
      bucket: bucketOf(botEvents.occurredAt),
      net: sql<string>`coalesce(sum(substring(${botEvents.why} from ${NET_RE})::numeric), 0)::text`,
      trades: sql<number>`count(*)::int`,
      // Thắng = lãi giá > 0, trước phí (DEC-129). Dòng cũ chưa ghi "price PnL" thì so giá vào / ra theo chiều lệnh;
      // dòng cũ hơn nữa không có giá thì đành dùng lãi ròng.
      wins: sql<number>`count(*) filter (where coalesce(
        substring(${botEvents.why} from ${PRICE_RE})::numeric,
        case ${botEvents.decision}
          when 'Closed long' then substring(${botEvents.why} from ${EXIT_RE})::numeric - substring(${botEvents.why} from ${ENTRY_RE})::numeric
          when 'Closed short' then substring(${botEvents.why} from ${ENTRY_RE})::numeric - substring(${botEvents.why} from ${EXIT_RE})::numeric
        end,
        substring(${botEvents.why} from ${NET_RE})::numeric
      ) > 0)::int`,
    })
    .from(botEvents)
    .where(
      and(
        eq(botEvents.botId, botId),
        gte(botEvents.occurredAt, from),
        sql`${botEvents.decision} like 'Closed%'`,
        sql`${botEvents.why} ~ ${NET_RE}`,
      ),
    )
    .groupBy(sql`1`);

  const [ord] = await deps.db
    .select({
      placed: sql<number>`count(*)::int`,
      filled: sql<number>`count(*) filter (where ${orders.filledSize} > 0)::int`,
      rejected: sql<number>`count(*) filter (where ${orders.status} = 'rejected')::int`,
    })
    .from(orders)
    .where(
      and(
        eq(orders.botId, botId),
        gte(orders.submittedAt, from),
        // Stop loss gốc trên SoDEX không phải lệnh vào / ra: không tính vào tỷ lệ khớp.
        sql`${orders.tag} not like '%:sl'`,
      ),
    );

  const count = Math.max(1, Math.ceil(span / bucketMs));
  const zero = () => ({ volume: dec("0"), maker: dec("0"), fees: dec("0"), net: dec("0") });
  const buckets = Array.from({ length: count }, zero);
  const at = (i: number) => buckets[Math.min(count - 1, Math.max(0, i))] ?? zero();
  const totals = {
    volume: dec("0"),
    maker: dec("0"),
    buy: dec("0"),
    fees: dec("0"),
    builderFees: dec("0"),
    net: dec("0"),
    trades: 0,
    wins: 0,
  };
  for (const r of fillRows) {
    const x = at(r.bucket);
    x.volume = x.volume.add(r.volume);
    x.maker = x.maker.add(r.maker);
    x.fees = x.fees.add(r.fees);
    totals.volume = totals.volume.add(r.volume);
    totals.maker = totals.maker.add(r.maker);
    totals.buy = totals.buy.add(r.buy);
    totals.fees = totals.fees.add(r.fees);
    totals.builderFees = totals.builderFees.add(r.builder);
  }
  for (const r of closeRows) {
    at(r.bucket).net = at(r.bucket).net.add(r.net);
    totals.net = totals.net.add(r.net);
    totals.trades += r.trades;
    totals.wins += r.wins;
  }
  const s = (v: ReturnType<typeof dec>, dp = 4) => v.toDecimalPlaces(dp).toString();
  return {
    period,
    from: iso(from),
    to: iso(now),
    bucketMs,
    series: buckets.map((x, i) => ({
      t: iso(new Date(from.getTime() + i * bucketMs)),
      volume: s(x.volume, 2),
      maker: s(x.maker, 2),
      fees: s(x.fees),
      net: s(x.net),
    })),
    totals: {
      volume: s(totals.volume, 2),
      maker: s(totals.maker, 2),
      buy: s(totals.buy, 2),
      fees: s(totals.fees),
      builderFees: s(totals.builderFees),
      net: s(totals.net),
      trades: totals.trades,
      wins: totals.wins,
      ordersPlaced: ord?.placed ?? 0,
      ordersFilled: ord?.filled ?? 0,
      ordersRejected: ord?.rejected ?? 0,
    },
  };
}

export const VOLUME_ANALYTICS_STRATEGIES = new Set<string>([
  Strategy.volumeFarm,
  Strategy.volumeMaker,
]);
