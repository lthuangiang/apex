import { bots, botVersions, deskWhatifs, fills, orders } from "@drift/db";
import {
  applyPatch,
  dec,
  feeRateToFraction,
  SODEX_BASE_FEE_PCT,
  WHATIF_CONFIG,
  type WhatIfOptionResult,
} from "@drift/shared";
import {
  backtest,
  currentParams,
  realFeeRates,
  replayOptions,
  reviewTrades,
  STRATEGIES,
  volumeFarmSchema,
  type ReplayOption,
  type ReviewFill,
} from "@drift/strategies";
import { and, eq, gte, like, lt } from "drizzle-orm";

import { loadBacktestData, loadCandles, Unavailable, userBuilderRate, type RunDeps } from "./run";

// What-if của AI Desk B+ M2 (DEC-166): tính kết quả 7 ngày qua cho từng phương án của một việc "Needs you".
// - Volume Builder: replay lối ra trên đúng lượt vào thật trong cửa sổ (cách của Review this run, DEC-131).
// - Chiến lược khác: backtest trên nến 5 phút của cùng cửa sổ (P9). Backtest không tách được lượt và không mô phỏng
//   thanh lý: "closed by SoDEX", lượt tệ nhất, ký quỹ mỗi lệnh để null ("Not available"), không đoán.
// Kết quả là quá khứ, không phải dự báo. Không gửi lệnh, không sửa bot.

/** Nến cần sau lượt cuối: replay tối đa 15 phút sau khi vào lệnh. */
const TAIL_MS = 20 * 60_000;
const BACKTEST_INTERVAL = "5m";

type Options = WhatIfOptionResult[];

const usd = (n: number): string => dec(n.toFixed(6)).toDecimalPlaces(2).toString();

function parseOrNull(strategy: string, config: unknown): Record<string, unknown> | null {
  const entry = (
    STRATEGIES as Record<
      string,
      { schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown } } } | undefined
    >
  )[strategy];
  const r = entry?.schema.safeParse(config);
  return r?.success === true ? (r.data as Record<string, unknown>) : null;
}

async function replayVolumeFarm(
  deps: RunDeps,
  bot: typeof bots.$inferSelect,
  config: Record<string, unknown>,
  options: Options,
  from: number,
  to: number,
): Promise<Options> {
  const rows = await deps.db
    .select({
      tag: orders.tag,
      side: orders.side,
      price: fills.price,
      size: fills.size,
      fee: fills.fee,
      builderFee: fills.builderFee,
      isMaker: fills.isMaker,
      at: fills.filledAt,
    })
    .from(fills)
    .innerJoin(orders, eq(orders.id, fills.orderId))
    .where(
      and(
        eq(orders.botId, bot.id),
        like(orders.tag, "vf:%"),
        gte(fills.filledAt, new Date(from)),
        lt(fills.filledAt, new Date(to)),
      ),
    );
  const fs: ReviewFill[] = rows.map((r) => ({
    tag: r.tag,
    side: r.side,
    price: Number(r.price),
    size: Number(r.size),
    fee: Number(r.fee),
    builderFee: Number(r.builderFee ?? "0"),
    isMaker: r.isMaker === true,
    at: r.at.getTime(),
  }));
  const trades = reviewTrades(fs);
  if (trades.length < WHATIF_CONFIG.minTrades)
    return options.map((o) => ({ ...o, outcome: null, unavailable: "not_enough_trades" }));
  const first = trades[0]?.t0 ?? from;
  const last = trades.at(-1)?.t0 ?? to;
  const candles = await loadCandles(
    deps,
    "perps",
    bot.market,
    "1m",
    Math.floor(first / 60_000) * 60_000,
    last + TAIL_MS,
  );
  if (candles.length === 0)
    return options.map((o) => ({ ...o, outcome: null, unavailable: "no_data" }));
  const builder = feeRateToFraction(
    await userBuilderRate(deps.db, bot.userId, bot.strategy),
  ).toNumber();
  const pct = (x: string) => dec(x).div(100).toNumber();
  const fee = realFeeRates(fs, {
    maker: pct(SODEX_BASE_FEE_PCT.perps.maker) + builder,
    taker: pct(SODEX_BASE_FEE_PCT.perps.taker) + builder,
  });
  return options.map((o) => {
    const parsed = volumeFarmSchema.safeParse(applyPatch(config, o.patch));
    if (!parsed.success) return { ...o, outcome: null, unavailable: "invalid_config" };
    const opt: ReplayOption = {
      params: currentParams(parsed.data),
      leverage: parsed.data.leverage,
    };
    const [r] = replayOptions({
      trades,
      candles,
      tpUsd: Number(parsed.data.tpUsd),
      fee,
      options: [opt],
    });
    if (r === undefined) return { ...o, outcome: null, unavailable: "no_data" };
    return {
      ...o,
      unavailable: null,
      outcome: {
        trades: r.trades,
        net: usd(r.net),
        closedBySodex: r.slExits,
        worstTrade: r.worstTrade === null ? null : usd(r.worstTrade),
        marginPerTrade: r.marginPerTrade === null ? null : usd(r.marginPerTrade),
      },
    };
  });
}

async function backtestOptions(
  deps: RunDeps,
  bot: typeof bots.$inferSelect,
  config: Record<string, unknown>,
  options: Options,
  from: number,
  to: number,
): Promise<Options> {
  const data = await loadBacktestData(
    deps,
    bot.strategy,
    config,
    bot.userId,
    BACKTEST_INTERVAL,
    from,
    to,
  );
  return options.map((o) => {
    const patched = parseOrNull(bot.strategy, applyPatch(config, o.patch));
    if (patched === null) return { ...o, outcome: null, unavailable: "invalid_config" };
    const r = backtest(bot.strategy, patched, data);
    const trades = r.output.fills.length;
    if (trades < WHATIF_CONFIG.minTrades)
      return { ...o, outcome: null, unavailable: "not_enough_trades" };
    return {
      ...o,
      unavailable: null,
      outcome: {
        trades,
        net: dec(r.net).toDecimalPlaces(2).toString(),
        closedBySodex: null,
        worstTrade: null,
        marginPerTrade: null,
      },
    };
  });
}

export async function runWhatif(deps: RunDeps, whatifId: string): Promise<void> {
  const [w] = await deps.db.select().from(deskWhatifs).where(eq(deskWhatifs.id, whatifId)).limit(1);
  if (w === undefined || w.status === "done" || w.status === "unavailable") return;
  await deps.db.update(deskWhatifs).set({ status: "running" }).where(eq(deskWhatifs.id, whatifId));
  const finish = (set: Partial<typeof deskWhatifs.$inferInsert>) =>
    deps.db
      .update(deskWhatifs)
      .set({ ...set, finishedAt: deps.now() })
      .where(eq(deskWhatifs.id, whatifId));
  try {
    const [b] = await deps.db.select().from(bots).where(eq(bots.id, w.botId)).limit(1);
    const [v] = await deps.db
      .select({ config: botVersions.config, version: botVersions.version })
      .from(botVersions)
      .where(eq(botVersions.id, b?.activeVersionId ?? "00000000-0000-0000-0000-000000000000"))
      .limit(1);
    if (b === undefined || v === undefined) {
      await finish({ status: "unavailable", error: "bot" });
      return;
    }
    if (v.version !== w.botVersion) {
      await finish({ status: "unavailable", error: "version_changed" });
      return;
    }
    const config = v.config as Record<string, unknown>;
    const options = w.options as Options;
    const from = w.windowFrom.getTime();
    const to = w.windowTo.getTime();
    const replay = b.strategy === "volume_farm";
    const result = replay
      ? await replayVolumeFarm(deps, b, config, options, from, to)
      : await backtestOptions(deps, b, config, options, from, to);
    await finish({
      status: "done",
      source: replay ? "replay" : "backtest",
      options: result,
      error: null,
    });
  } catch (error) {
    if (error instanceof Unavailable) {
      await finish({ status: "unavailable", error: error.message });
      return;
    }
    await finish({ status: "failed", error: "internal" });
    throw error;
  }
}
