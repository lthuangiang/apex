import { signalPaperTrades, type Db } from "@drift/db";
import {
  closeResult,
  dec,
  exitCheck,
  NEWS_RULES,
  SignalOutcome,
  SignalReason,
  SignalStage,
  TradeDirection,
  type PaperExitReason,
  type Quote,
} from "@drift/shared";
import { and, eq } from "drizzle-orm";

import { isQuote } from "./prices";
import { markSource, recordEvents } from "./store";

// Bước 6 (#271): mỗi 1–2 s kiểm lệnh giấy đang mở theo bid / ask SoDEX (chỉ dữ liệu marketdata). Long đóng theo bid,
// short theo ask; chạm TP / SL hoặc hết giữ tối đa thì đóng. Không có giá → chờ, kiểm lại khi có giá.

type TradeRow = typeof signalPaperTrades.$inferSelect;

export interface WatcherDeps {
  db: Db;
  quotes: { quotes: (markets: readonly string[]) => Promise<Map<string, Quote | SignalReason>> };
  now: () => number;
  log: { info: (obj: object, msg: string) => void };
}

const RELOAD_MS = 30_000;
const HEALTH_MS = 60_000;

const REASON: Record<PaperExitReason, SignalReason> = {
  take_profit: SignalReason.takeProfit,
  stop_loss: SignalReason.stopLoss,
  max_hold: SignalReason.maxHold,
};

export class PaperWatcher {
  readonly #deps: WatcherDeps;
  #open: TradeRow[] = [];
  #loadedAt = 0;
  #busy = false;
  #healthAt = 0;

  constructor(deps: WatcherDeps) {
    this.#deps = deps;
  }

  /** Nạp lại danh sách lệnh mở ở lượt kế tiếp (gọi sau khi mở lệnh). */
  invalidate(): void {
    this.#loadedAt = 0;
  }

  /** Một lượt kiểm; lượt trước chưa xong thì bỏ qua. Trả số lệnh đã đóng. */
  async tick(): Promise<number> {
    if (this.#busy) return 0;
    this.#busy = true;
    try {
      return await this.#tick();
    } finally {
      this.#busy = false;
    }
  }

  async #tick(): Promise<number> {
    const { db } = this.#deps;
    const now = this.#deps.now();
    if (now - this.#loadedAt > RELOAD_MS) {
      this.#open = await db
        .select()
        .from(signalPaperTrades)
        .where(
          and(eq(signalPaperTrades.status, "open"), eq(signalPaperTrades.lane, NEWS_RULES.lane)),
        );
      this.#loadedAt = now;
    }
    // Sức khoẻ giá SoDEX (mỗi phút, kể cả khi không có lệnh mở): thử một market quen.
    const probe = this.#open.length === 0 && now - this.#healthAt > HEALTH_MS ? ["BTC-USD"] : [];
    if (this.#open.length === 0 && probe.length === 0) return 0;
    const quotes = await this.#deps.quotes.quotes([...this.#open.map((t) => t.market), ...probe]);
    if (now - this.#healthAt > HEALTH_MS) {
      this.#healthAt = now;
      const any = [...quotes.values()].some(isQuote);
      await markSource(db, "sodex_prices", now, any ? null : "no_fresh_price");
    }
    let closed = 0;
    for (const t of [...this.#open]) {
      const q = quotes.get(t.market);
      const exit = exitCheck(
        {
          direction: t.direction === "short" ? TradeDirection.short : TradeDirection.long,
          tpPrice: dec(t.tpPrice),
          slPrice: dec(t.slPrice),
          maxHoldUntil: t.maxHoldUntil.getTime(),
        },
        isQuote(q) ? q : null,
        now,
      );
      if (exit === null) continue;
      const r = closeResult({
        direction: t.direction === "short" ? TradeDirection.short : TradeDirection.long,
        entryPrice: t.entryPrice,
        exitPrice: exit.price,
        qty: t.qty,
        sizeUsdc: t.sizeUsdc,
        entryFee: t.entryFee,
        feePct: t.feePct,
      });
      const done = await db.transaction(async (tx) => {
        const rows = await tx
          .update(signalPaperTrades)
          .set({
            status: "closed",
            exitPrice: exit.price.toFixed(),
            exitReason: exit.reason,
            exitedAt: new Date(now),
            exitFee: r.exitFee.toFixed(18),
            resultUsdc: r.resultUsdc.toFixed(18),
            resultPct: r.resultPct.toFixed(18),
            updatedAt: new Date(now),
          })
          .where(and(eq(signalPaperTrades.id, t.id), eq(signalPaperTrades.status, "open")))
          .returning({ id: signalPaperTrades.id });
        if (rows.length === 0) return false;
        await recordEvents(tx, [
          {
            articleId: t.articleId,
            storyId: t.storyId,
            tradeId: t.id,
            stage: SignalStage.watch,
            outcome: SignalOutcome.close,
            reason: REASON[exit.reason],
            detail: {
              exitPrice: exit.price.toFixed(),
              resultUsdc: r.resultUsdc.toDecimalPlaces(6).toFixed(),
              priceSource: isQuote(q) ? q.source : null,
            },
            at: now,
          },
        ]);
        return true;
      });
      this.#open = this.#open.filter((x) => x.id !== t.id);
      if (!done) continue;
      closed += 1;
      this.#deps.log.info(
        {
          market: t.market,
          reason: exit.reason,
          resultUsdc: r.resultUsdc.toDecimalPlaces(4).toFixed(),
        },
        "signal research paper trade closed",
      );
    }
    return closed;
  }
}
