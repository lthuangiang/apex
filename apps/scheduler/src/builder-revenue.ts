import { builderBalanceSnapshots, builderRevenueDaily, fills, orders, type Db } from "@drift/db";
import { balanceDeltas, reconcileBuilderDay } from "@drift/shared";
import type { SodexRestClient } from "@drift/sodex";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { Address } from "viem";

// Builder revenue (SODEX.md mục 5.4, DEC-41): mỗi ngày (UTC) chụp số dư vUSDC của tài khoản builder trên từng
// engine, rồi đối soát ngày hôm trước: Σ `builder_fee` trên fill của DRIFT so với biến động số dư.

export interface RevenueDeps {
  db: Db;
  rest: Pick<SodexRestClient, "getSpotBalances" | "getPerpsAccountState">;
  builderAddress: Address;
  now: () => number;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export async function snapshotBuilderBalances(deps: RevenueDeps): Promise<void> {
  const date = day(deps.now());
  const [spot, perps] = await Promise.all([
    deps.rest.getSpotBalances(deps.builderAddress),
    deps.rest.getPerpsAccountState(deps.builderAddress),
  ]);
  const spotUsdc = spot.find((b) => b.coin === "vUSDC")?.total ?? "0";
  // Perps: builder fee cộng vào số dư ví vUSDC (`wb` của balance vUSDC); `av` gồm cả PnL nên không dùng.
  const perpsUsdc = perps.B.find((b) => b.a === "vUSDC")?.wb ?? "0";
  for (const [engine, balance] of [
    ["spot", spotUsdc],
    ["perps", perpsUsdc],
  ] as const) {
    await deps.db
      .insert(builderBalanceSnapshots)
      .values({ date, engine, balance, takenAt: new Date(deps.now()) })
      .onConflictDoNothing();
  }
}

/** Đối soát ngày `date` (YYYY-MM-DD) cho cả hai engine; ghi đè dòng cũ. */
export async function reconcileDay(db: Db, date: string): Promise<void> {
  const from = new Date(`${date}T00:00:00Z`);
  const to = new Date(from.getTime() + 86_400_000);
  const sums = await db
    .select({
      engine: orders.engine,
      fee: sql<string>`coalesce(sum(${fills.builderFee}), 0)::text`,
      n: sql<number>`count(*)::int`,
      notional: sql<string>`coalesce(sum(${fills.price} * ${fills.size}), 0)::text`,
    })
    .from(fills)
    .innerJoin(orders, eq(orders.id, fills.orderId))
    .where(and(gte(fills.filledAt, from), lt(fills.filledAt, to)))
    .groupBy(orders.engine);
  const nextDay = day(to.getTime());
  const snaps = await db
    .select()
    .from(builderBalanceSnapshots)
    .where(sql`${builderBalanceSnapshots.date} in (${date}, ${nextDay})`);
  // Snapshot chụp đầu mỗi ngày (UTC); biến động của ngày D = snapshot(D+1) − snapshot(D).
  const deltas = balanceDeltas(
    snaps.map((s) => ({
      date: s.date === nextDay ? "b" : "a",
      engine: s.engine,
      balance: s.balance,
    })),
  );
  for (const engine of ["spot", "perps"] as const) {
    const s = sums.find((x) => x.engine === engine);
    const row = reconcileBuilderDay({
      date,
      engine,
      fromFills: s?.fee ?? "0",
      balanceDelta: deltas.get(`b:${engine}`) ?? null,
    });
    const values = {
      date,
      engine,
      fromFills: row.fromFills,
      fills: s?.n ?? 0,
      notional: s?.notional ?? "0",
      balanceDelta: row.balanceDelta,
      difference: row.difference,
      status: row.status,
    };
    await db
      .insert(builderRevenueDaily)
      .values(values)
      .onConflictDoUpdate({
        target: [builderRevenueDaily.date, builderRevenueDaily.engine],
        set: { ...values, updatedAt: new Date() },
      });
  }
}
