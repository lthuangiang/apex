import { signalPaperTrades, type Db } from "@drift/db";
import {
  dec,
  Decimal,
  NEWS_RULES,
  randomResult,
  replayOnCandles,
  TradeDirection,
} from "@drift/shared";
import { and, asc, count, eq, isNull, lt, sql } from "drizzle-orm";

import { candlesOf } from "./store";

// Random baseline của lệnh tin tức (#271, review PR #278 M4): tính MỘT lần cho mỗi lệnh đã đóng và lưu vào
// `signal_paper_trades`, để báo cáo chỉ đọc cột (không phát lại nến ở mỗi request). Lệnh ngẫu nhiên cùng thời điểm vào,
// cùng market, cùng TP / SL / giữ tối đa, phát lại theo cả hai chiều trên nến 1 phút của đúng market đó; trừ cùng chi phí
// với lệnh thật (phí 2 chiều + spread lúc vào). Lệnh ngẫu nhiên có thể còn "mở" khi lệnh thật đã đóng, nên chỉ chọn lệnh mà
// cửa sổ giữ tối đa đã qua (cũ nhất trước): mỗi lệnh được chọn đúng một lần, không lệnh nào bị kẹt đầu hàng. Tỉ lệ Long của
// lệnh ngẫu nhiên lấy TẠI LÚC TÍNH (các lệnh đã đóng cùng version), lưu kèm ở `random_long_share`.

const MIN_MS = 60_000;
/** Mỗi chu kỳ tính tối đa ngần này lệnh (mỗi lệnh 1 truy vấn nến theo market, ≤ 3 ngày). */
const PER_CYCLE = 20;

export async function fillRandomBaselines(db: Db, now: number): Promise<number> {
  const todo = await db
    .select()
    .from(signalPaperTrades)
    .where(
      and(
        eq(signalPaperTrades.status, "closed"),
        isNull(signalPaperTrades.randomDoneAt),
        eq(signalPaperTrades.lane, NEWS_RULES.lane),
        eq(signalPaperTrades.label, "live"),
        lt(signalPaperTrades.maxHoldUntil, new Date(now - 2 * MIN_MS)),
      ),
    )
    .orderBy(asc(signalPaperTrades.maxHoldUntil), asc(signalPaperTrades.id))
    .limit(PER_CYCLE);
  if (todo.length === 0) return 0;
  let done = 0;
  for (const t of todo) {
    const from = Math.floor(t.openedAt.getTime() / MIN_MS) * MIN_MS + MIN_MS;
    const holdEnd = t.maxHoldUntil.getTime();
    const until = holdEnd;
    const candles = until > from ? await candlesOf(db, t.market, from, until) : [];
    const run = (direction: TradeDirection) =>
      replayOnCandles({
        direction,
        entry: t.entryMid,
        tpPct: t.tpPct,
        slPct: t.slPct,
        candles,
        from,
        until,
      });
    const long = run(TradeDirection.long);
    const short = run(TradeDirection.short);
    const cost = dec(t.feePct).mul(2).add(dec(t.spreadAtEntryPct));
    // Tỉ lệ Long dùng cho lệnh ngẫu nhiên: của các lệnh đã đóng cùng version, lúc tính (lưu kèm để báo cáo).
    const [dirs] = await db
      .select({
        total: count(),
        longs: sql<number>`count(*) filter (where ${signalPaperTrades.direction} = 'long')::int`,
      })
      .from(signalPaperTrades)
      .where(
        and(
          eq(signalPaperTrades.status, "closed"),
          eq(signalPaperTrades.lane, NEWS_RULES.lane),
          eq(signalPaperTrades.label, "live"),
          eq(signalPaperTrades.ruleVersion, t.ruleVersion),
        ),
      );
    const total = dirs?.total ?? 0;
    const p = total === 0 ? new Decimal(0) : new Decimal(dirs?.longs ?? 0).div(total);
    const lp = long === null ? null : long.pct.sub(cost);
    const sp = short === null ? null : short.pct.sub(cost);
    await db
      .update(signalPaperTrades)
      .set({
        randomLongPct: lp?.toFixed(18) ?? null,
        randomShortPct: sp?.toFixed(18) ?? null,
        randomPct: lp === null || sp === null ? null : randomResult(lp, sp, p).toFixed(18),
        randomLongShare: p.toFixed(18),
        randomDoneAt: new Date(now),
        updatedAt: new Date(now),
      })
      .where(eq(signalPaperTrades.id, t.id));
    done += 1;
  }
  return done;
}
