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

/**
 * Nến đầu tiên lệnh ngẫu nhiên được xét (#405, DEC-TBD-sr-baseline-entry-clock): phút kế tiếp sau lúc vào lệnh THẬT
 * (`opened_clock_at`, #379), vì entry là giá live đọc lúc đó; nến trước entry (từ đầu chu kỳ tới lúc vào) không được chạm
 * TP / SL. Lệnh cũ chưa có `opened_clock_at` giữ `opened_at` (giờ đầu chu kỳ) như trước. Làm tròn lên phút kế tiếp như cũ
 * (không nhìn nến chứa lúc vào, vì nến đó có phần trước entry).
 */
export function randomReplayFrom(t: { openedAt: Date; openedClockAt: Date | null }): number {
  const at = (t.openedClockAt ?? t.openedAt).getTime();
  return Math.floor(at / MIN_MS) * MIN_MS + MIN_MS;
}

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
    // Chỉ lệnh chưa có baseline (`random_done_at` null) đi qua đây: baseline đã lưu không bị tính lại (#405).
    const from = randomReplayFrom(t);
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
          // Riêng từng News bot version (#303); lệnh không có version (cũ) dùng chung nhóm null.
          t.versionId === null
            ? isNull(signalPaperTrades.versionId)
            : eq(signalPaperTrades.versionId, t.versionId),
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
