import { signalPaperTrades, type Db } from "@drift/db";
import {
  closeResult,
  dec,
  exitCheck,
  favourableMovePct,
  Decimal,
  midOf,
  NEWS_RULES,
  SignalOutcome,
  SignalReason,
  SignalStage,
  SR_WATCH_REST,
  srQuotesSnapshot,
  TradeDirection,
  PaperExitReason,
  type Quote,
  type SrQuotesSnapshot,
} from "@drift/shared";
import { and, eq, inArray } from "drizzle-orm";

import { isQuote } from "./prices";
import { markSource, recordEvents } from "./store";

// Bước 6 (#271): mỗi 1–2 s kiểm lệnh giấy đang mở theo bid / ask SoDEX (chỉ dữ liệu marketdata). Long đóng theo bid,
// short theo ask; chạm TP / SL hoặc hết giữ tối đa thì đóng. Không có giá → chờ, kiểm lại khi có giá. Lệnh của mọi News bot
// version, kể cả lệnh shadow (#303); đóng vì tin ngược chiều do pipeline làm (cập nhật có điều kiện `status = 'open'`).
// #511 (DEC-384): lệnh mở trên market không có giá (không sổ live, không mẫu spread) đọc sổ REST qua marketdata
// theo `SR_WATCH_REST` (mỗi market tối đa mỗi 15 s, tối đa 10 lần đọc mỗi 15 s, ưu tiên lệnh đã quá hạn giữ). Quá hạn giữ
// thêm 1 giờ mà vẫn không có giá: đóng `max_hold_no_price`, không có giá thoát / phí ra / kết quả (null, quy tắc 1.8).

type TradeRow = typeof signalPaperTrades.$inferSelect;

export interface WatcherDeps {
  db: Db;
  quotes: {
    quotes: (markets: readonly string[]) => Promise<Map<string, Quote | SignalReason>>;
    /** #511: sổ REST một lần (qua marketdata) cho market không có giá; thiếu = không đọc REST. */
    restQuote?: (market: string) => Promise<Quote | null>;
  };
  now: () => number;
  log: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
  /**
   * #308: ghi bid / ask của market có lệnh mở (Redis `sr:quotes`) để api tính lãi / lỗ chưa chốt theo giá thoát thật.
   * Không truyền → không ghi.
   */
  publishQuotes?: (snapshot: SrQuotesSnapshot) => Promise<void>;
}

const RELOAD_MS = 30_000;
const HEALTH_MS = 60_000;
const SAVE_MS = 60_000;

const REASON: Record<PaperExitReason, SignalReason> = {
  take_profit: SignalReason.takeProfit,
  stop_loss: SignalReason.stopLoss,
  max_hold: SignalReason.maxHold,
  max_hold_no_price: SignalReason.maxHoldNoPrice,
  opposite_news: SignalReason.oppositeNews,
};

/**
 * #511: market nào được đọc sổ REST ở lượt này (thuần, có test). Mỗi market tối đa mỗi `everyMs`; lần đầu sau khi lệnh quá
 * hạn giữ thì đọc ngay; tổng số lần đọc trong `everyMs` gần nhất (`readsInWindow` + lượt này) ≤ `maxMarkets`. Ưu tiên market
 * có lệnh đã quá hạn giữ, rồi market lâu chưa đọc nhất (chưa đọc lần nào trước hết).
 */
export function pickRestMarkets(
  need: ReadonlyMap<string, { overdue: boolean; holdEnd: number }>,
  lastRead: ReadonlyMap<string, number>,
  readsInWindow: number,
  now: number,
): string[] {
  const room = SR_WATCH_REST.maxMarkets - readsInWindow;
  if (room <= 0) return [];
  return [...need]
    .filter(([m, x]) => {
      const last = lastRead.get(m);
      return (
        last === undefined || now - last >= SR_WATCH_REST.everyMs || (x.overdue && last < x.holdEnd)
      );
    })
    .sort(
      (a, b) =>
        Number(b[1].overdue) - Number(a[1].overdue) ||
        (lastRead.get(a[0]) ?? 0) - (lastRead.get(b[0]) ?? 0),
    )
    .slice(0, room)
    .map(([m]) => m);
}

export class PaperWatcher {
  readonly #deps: WatcherDeps;
  #open: TradeRow[] = [];
  #loadedAt = 0;
  #busy = false;
  #healthAt = 0;
  /** MFE / MAE (%, theo chiều lệnh, giá giữa) của lệnh đang mở; ghi DB mỗi phút nếu đổi, và lúc đóng. */
  readonly #excursion = new Map<
    string,
    { best: Decimal | null; worst: Decimal | null; dirty: boolean }
  >();
  #savedAt = 0;
  /** #511: lần đọc sổ REST gần nhất theo market, và mốc các lần đọc trong `SR_WATCH_REST.everyMs` gần nhất (trần). */
  readonly #restAt = new Map<string, number>();
  #restReads: number[] = [];

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
          and(
            eq(signalPaperTrades.status, "open"),
            eq(signalPaperTrades.lane, NEWS_RULES.lane),
            // Lệnh thật và lệnh shadow (#303) của mọi version đều theo dõi tới TP / SL / giữ tối đa.
            inArray(signalPaperTrades.label, ["live", "shadow"]),
          ),
        );
      this.#loadedAt = now;
      const ids = new Set(this.#open.map((t) => t.id));
      for (const id of this.#excursion.keys()) if (!ids.has(id)) this.#excursion.delete(id);
      const openMarkets = new Set(this.#open.map((t) => t.market));
      for (const m of this.#restAt.keys()) if (!openMarkets.has(m)) this.#restAt.delete(m);
      for (const t of this.#open)
        if (!this.#excursion.has(t.id))
          this.#excursion.set(t.id, {
            // null tới lần quan sát giá đầu tiên (không bao giờ 0 khi chưa thấy giá).
            best: t.mfePct === null ? null : dec(t.mfePct),
            worst: t.maePct === null ? null : dec(t.maePct),
            dirty: false,
          });
    }
    // Sức khoẻ giá SoDEX (mỗi phút, kể cả khi không có lệnh mở): thử một market quen.
    const probe = this.#open.length === 0 && now - this.#healthAt > HEALTH_MS ? ["BTC-USD"] : [];
    if (this.#open.length === 0 && probe.length === 0) return 0;
    const quotes = await this.#withRest(
      await this.#deps.quotes.quotes([...this.#open.map((t) => t.market), ...probe]),
      now,
    );
    if (now - this.#healthAt > HEALTH_MS) {
      this.#healthAt = now;
      const any = [...quotes.values()].some(isQuote);
      await markSource(db, "sodex_prices", now, any ? null : "no_fresh_price");
    }
    let closed = 0;
    for (const t of [...this.#open]) {
      const q = quotes.get(t.market);
      const ex = this.#excursion.get(t.id);
      if (isQuote(q) && ex !== undefined) {
        const m = favourableMovePct(
          t.direction === "short" ? TradeDirection.short : TradeDirection.long,
          dec(t.entryPrice),
          midOf(q),
        );
        // MFE ≥ 0, MAE ≤ 0 (so với giá vào); lần quan sát đầu tiên đặt cả hai.
        const best = ex.best ?? new Decimal(0);
        const worst = ex.worst ?? new Decimal(0);
        if (ex.best === null || m.gt(best))
          Object.assign(ex, { best: m.gt(best) ? m : best, dirty: true });
        if (ex.worst === null || m.lt(worst))
          Object.assign(ex, { worst: m.lt(worst) ? m : worst, dirty: true });
      }
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
      if (exit === null) {
        // #511: quá hạn giữ + 1 giờ mà vẫn không có giá (cả sổ REST): đóng không có giá thoát / kết quả.
        if (!isQuote(q) && now >= t.maxHoldUntil.getTime() + SR_WATCH_REST.noPriceGraceMs) {
          if (await this.#closeNoPrice(t, ex, now)) closed += 1;
        }
        continue;
      }
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
            ...(ex === undefined
              ? {}
              : {
                  mfePct: ex.best?.toFixed(18) ?? null,
                  maePct: ex.worst?.toFixed(18) ?? null,
                }),
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
            versionId: t.versionId,
            stage: SignalStage.watch,
            outcome: SignalOutcome.close,
            reason: REASON[exit.reason],
            detail: {
              exitPrice: exit.price.toFixed(),
              resultUsdc: r.resultUsdc.toDecimalPlaces(6).toFixed(),
              priceSource: isQuote(q) ? q.source : null,
              ...(t.label === "shadow" ? { shadow: true } : {}),
            },
            at: now,
          },
        ]);
        return true;
      });
      this.#open = this.#open.filter((x) => x.id !== t.id);
      this.#excursion.delete(t.id);
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
    if (now - this.#savedAt > SAVE_MS) {
      this.#savedAt = now;
      for (const [id, ex] of this.#excursion) {
        if (!ex.dirty) continue;
        ex.dirty = false;
        await db
          .update(signalPaperTrades)
          .set({ mfePct: ex.best?.toFixed(18) ?? null, maePct: ex.worst?.toFixed(18) ?? null })
          .where(and(eq(signalPaperTrades.id, id), eq(signalPaperTrades.status, "open")));
      }
    }
    await this.#publish(quotes);
    return closed;
  }

  /**
   * #511: thêm sổ REST cho market có lệnh mở mà không có giá. Mỗi market tối đa mỗi `everyMs` (lần đầu sau khi quá hạn giữ
   * thì đọc ngay), tối đa `maxMarkets` lần đọc trong mỗi `everyMs`; ưu tiên market có lệnh đã quá hạn giữ, rồi market lâu
   * chưa đọc nhất. Market có sổ live / giá thì không đọc.
   */
  async #withRest(
    quotes: Map<string, Quote | SignalReason>,
    now: number,
  ): Promise<Map<string, Quote | SignalReason>> {
    const source = this.#deps.quotes;
    if (source.restQuote === undefined) return quotes;
    const rest = (m: string) => source.restQuote?.(m) ?? Promise.resolve(null);
    const need = new Map<string, { overdue: boolean; holdEnd: number }>();
    for (const t of this.#open) {
      if (isQuote(quotes.get(t.market))) continue;
      const holdEnd = t.maxHoldUntil.getTime();
      const cur = need.get(t.market);
      need.set(t.market, {
        overdue: (cur?.overdue ?? false) || now >= holdEnd,
        holdEnd: Math.min(cur?.holdEnd ?? Number.POSITIVE_INFINITY, holdEnd),
      });
    }
    if (need.size === 0) return quotes;
    this.#restReads = this.#restReads.filter((at) => now - at < SR_WATCH_REST.everyMs);
    const due = pickRestMarkets(need, this.#restAt, this.#restReads.length, now);
    if (due.length === 0) return quotes;
    for (const m of due) {
      this.#restAt.set(m, now);
      this.#restReads.push(now);
    }
    const got = await Promise.all(
      due.map(async (m) => [m, await rest(m).catch(() => null)] as const),
    );
    const out = new Map(quotes);
    for (const [m, q] of got) if (q !== null) out.set(m, q);
    return out;
  }

  /** #511: đóng `max_hold_no_price`; giá thoát, phí ra, kết quả để null. Trả true khi chính lượt này đóng. */
  async #closeNoPrice(
    t: TradeRow,
    ex: { best: Decimal | null; worst: Decimal | null } | undefined,
    now: number,
  ): Promise<boolean> {
    const { db } = this.#deps;
    const done = await db.transaction(async (tx) => {
      const rows = await tx
        .update(signalPaperTrades)
        .set({
          status: "closed",
          exitPrice: null,
          exitReason: PaperExitReason.maxHoldNoPrice,
          exitedAt: new Date(now),
          exitFee: null,
          resultUsdc: null,
          resultPct: null,
          ...(ex === undefined
            ? {}
            : { mfePct: ex.best?.toFixed(18) ?? null, maePct: ex.worst?.toFixed(18) ?? null }),
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
          versionId: t.versionId,
          stage: SignalStage.watch,
          outcome: SignalOutcome.close,
          reason: SignalReason.maxHoldNoPrice,
          detail: {
            exitPrice: null,
            resultUsdc: null,
            priceSource: null,
            ...(t.label === "shadow" ? { shadow: true } : {}),
          },
          at: now,
        },
      ]);
      return true;
    });
    this.#open = this.#open.filter((x) => x.id !== t.id);
    this.#excursion.delete(t.id);
    if (done)
      this.#deps.log.info(
        { market: t.market, reason: PaperExitReason.maxHoldNoPrice },
        "signal research paper trade closed",
      );
    return done;
  }

  /** Bản chụp giá mỗi lượt có lệnh mở; giá không có / cũ thì vắng mặt (api hiện như chưa có giá). Lỗi Redis chỉ log. */
  async #publish(quotes: ReadonlyMap<string, Quote | SignalReason>): Promise<void> {
    const publish = this.#deps.publishQuotes;
    if (publish === undefined || this.#open.length === 0) return;
    const markets = new Set(this.#open.map((t) => t.market));
    const live = new Map<string, Quote>();
    for (const [m, q] of quotes) if (markets.has(m) && isQuote(q)) live.set(m, q);
    try {
      await publish(srQuotesSnapshot(live));
    } catch (err) {
      this.#deps.log.warn({ err }, "signal research quotes snapshot not written");
    }
  }
}
