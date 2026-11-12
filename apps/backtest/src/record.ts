import { bots, botVersions, deskApplies } from "@drift/db";
import { dec, RECORD_CONFIG, verdictOf, WHATIF_CONFIG, type DeskRecordResult } from "@drift/shared";
import { backtest, currentParams, replayOptions, volumeFarmSchema } from "@drift/strategies";
import { and, asc, eq, gt, isNotNull } from "drizzle-orm";

import { loadBacktestData, Unavailable, type RunDeps } from "./run";
import { BACKTEST_INTERVAL, parseOrNull, usd, volumeReplayInputs } from "./whatif";

// Thành tích của AI Desk B+ M4 (DEC-166, DEC-177): 7 ngày sau khi version "AI suggested" được áp,
// so kết quả sau khi sửa với cấu hình cũ trên cùng các ngày.
// - Volume Builder: lãi / lỗ ròng thật của các lượt trong cửa sổ so với replay cấu hình cũ trên đúng các lượt vào đó.
// - Chiến lược khác: backtest nến 5 phút cả cấu hình cũ lẫn mới trên cùng cửa sổ (cùng thước đo; backtest không tính
//   trượt giá như thật nên không so thật với backtest).
// Cửa sổ dừng sớm nếu user đổi sang version khác trước 7 ngày. Ít lượt / thiếu dữ liệu → `unavailable`, không ghi 0.

type Measured =
  { after: string; old: string; trades: number | null } | "not_enough_trades" | "no_data";

async function measureVolumeFarm(
  deps: RunDeps,
  bot: typeof bots.$inferSelect,
  baseline: Record<string, unknown>,
  from: number,
  to: number,
): Promise<Measured | "invalid_config"> {
  const parsed = volumeFarmSchema.safeParse(baseline);
  if (!parsed.success) return "invalid_config";
  const input = await volumeReplayInputs(deps, bot, from, to);
  if (typeof input === "string") return input;
  const actual = input.trades.reduce((s, t) => s + (t.gross - t.fees), 0);
  const [old] = replayOptions({
    trades: input.trades,
    candles: input.candles,
    tpUsd: Number(parsed.data.tpUsd),
    fee: input.fee,
    options: [{ params: currentParams(parsed.data), leverage: parsed.data.leverage }],
  });
  if (old === undefined) return "no_data";
  return { after: usd(actual), old: usd(old.net), trades: input.trades.length };
}

async function measureBacktest(
  deps: RunDeps,
  bot: typeof bots.$inferSelect,
  baseline: Record<string, unknown>,
  current: Record<string, unknown>,
  from: number,
  to: number,
): Promise<Measured | "invalid_config"> {
  const before = parseOrNull(bot.strategy, baseline);
  const after = parseOrNull(bot.strategy, current);
  if (before === null || after === null) return "invalid_config";
  const data = await loadBacktestData(
    deps,
    bot.strategy,
    current,
    bot.userId,
    BACKTEST_INTERVAL,
    from,
    to,
  );
  const a = backtest(bot.strategy, after, data);
  const b = backtest(bot.strategy, before, data);
  if (
    a.output.fills.length < WHATIF_CONFIG.minTrades ||
    b.output.fills.length < WHATIF_CONFIG.minTrades
  )
    return "not_enough_trades";
  return {
    after: dec(a.net).toDecimalPlaces(2).toString(),
    old: dec(b.net).toDecimalPlaces(2).toString(),
    trades: null,
  };
}

export async function runRecord(deps: RunDeps, applyId: string): Promise<void> {
  const [a] = await deps.db.select().from(deskApplies).where(eq(deskApplies.id, applyId)).limit(1);
  if (a?.recordStatus !== "queued" || a.toVersion === null) return;
  const finish = (set: Partial<typeof deskApplies.$inferInsert>) =>
    deps.db
      .update(deskApplies)
      .set({ ...set, checkedAt: deps.now(), updatedAt: deps.now() })
      .where(eq(deskApplies.id, applyId));
  try {
    const [b] = await deps.db.select().from(bots).where(eq(bots.id, a.botId)).limit(1);
    const [v] = await deps.db
      .select({ config: botVersions.config, at: botVersions.appliedAt })
      .from(botVersions)
      .where(and(eq(botVersions.botId, a.botId), eq(botVersions.version, a.toVersion)))
      .limit(1);
    if (b === undefined || v?.at == null) {
      await finish({ recordStatus: "unavailable", recordError: "bot" });
      return;
    }
    // Version sau đó (user tự sửa, Switch back…) được áp trước 7 ngày: chỉ đo những ngày version AI chạy.
    const [next] = await deps.db
      .select({ at: botVersions.appliedAt })
      .from(botVersions)
      .where(
        and(
          eq(botVersions.botId, a.botId),
          gt(botVersions.version, a.toVersion),
          isNotNull(botVersions.appliedAt),
        ),
      )
      .orderBy(asc(botVersions.appliedAt))
      .limit(1);
    const from = v.at.getTime();
    const end = from + RECORD_CONFIG.measureMs;
    const to = next?.at == null ? end : Math.min(end, next.at.getTime());
    const baseline = a.baselineConfig as Record<string, unknown>;
    const replay = b.strategy === "volume_farm";
    const m = replay
      ? await measureVolumeFarm(deps, b, baseline, from, to)
      : await measureBacktest(deps, b, baseline, v.config as Record<string, unknown>, from, to);
    if (typeof m === "string") {
      await finish({ recordStatus: "unavailable", recordError: m });
      return;
    }
    const record: DeskRecordResult = {
      source: replay ? "replay" : "backtest",
      after: m.after,
      old: m.old,
      trades: m.trades,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
    };
    await finish({
      recordStatus: "done",
      record,
      verdict: verdictOf(m.after, m.old),
      recordError: null,
    });
  } catch (error) {
    if (error instanceof Unavailable) {
      await finish({ recordStatus: "unavailable", recordError: error.message });
      return;
    }
    // Lỗi tạm (mạng, DB): trả về `measuring` để scheduler xếp lại ở lượt sau, rồi ném để log.
    await deps.db
      .update(deskApplies)
      .set({ recordStatus: "measuring", updatedAt: deps.now() })
      .where(eq(deskApplies.id, applyId));
    throw error;
  }
}
