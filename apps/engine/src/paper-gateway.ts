import {
  botVersions,
  bots,
  orders,
  paperAccounts,
  paperFills,
  paperSnapshots,
  userBuilderFees,
  type Db,
} from "@drift/db";
import {
  builderFeeRateFor,
  builderFeeRateOf,
  builderRateOnFill,
  dec,
  Decimal,
  feeRateToFraction,
  SODEX_BASE_FEE_PCT,
} from "@drift/shared";
import {
  paperApplyFill,
  paperCheck,
  paperCrosses,
  paperEquity,
  paperFillPrice,
  paperFunding,
  type OrderIntent,
  type PaperBook,
  type PaperOrder,
} from "@drift/strategies";
import { and, eq, inArray, sql } from "drizzle-orm";

import type {
  AccountRef,
  CancelResult,
  Fence,
  Gateway,
  LeverageResult,
  LeverageSetting,
  LookupResult,
  ModifyStopResult,
  OrderTrade,
  SubmitResult,
} from "./gateway";

// Cổng đặt lệnh của bot paper (DEC-105, AI_DESK_RECOMMENDED.md mục 8): KHÔNG có client SoDEX, signer hay key nào ở
// đây. Lệnh chỉ được ghi và mô phỏng trong DB của DRIFT; khớp khi giá thật đi xuyên qua (`@drift/strategies`
// paper). Fill ghi vào `paper_fills`, không bao giờ vào `fills`. Chỉ nhận account có cờ `paper`.

export class PaperOnlyError extends Error {
  constructor() {
    super("PaperGateway only accepts paper bots");
  }
}

/** Một lần khớp mô phỏng; engine đưa vào `onFill` như fill thật để chiến lược cập nhật sổ cái. */
export interface PaperFillEvent {
  accountId: string;
  clOrdID: string;
  totalFilled: string;
  avgPrice: string;
  fee: string;
}

const OPEN = ["open", "partially_filled"] as const;
const pct = (v: string) => dec(v).div(100);

function assertPaper(account: AccountRef): void {
  if (account.paper !== true) throw new PaperOrderRefused();
}
class PaperOrderRefused extends PaperOnlyError {}

export class PaperGateway implements Gateway {
  readonly #prices = new Map<string, string>();
  #orderId = 1n;

  constructor(
    private readonly d: {
      db: Db;
      now: () => number;
      slippage?: string;
    },
  ) {}

  /** Giá thật gần nhất của market (engine gọi mỗi khi có giá mới). */
  setPrice(market: string, price: string): void {
    this.#prices.set(market, price);
  }

  priceOf(market: string): string | null {
    return this.#prices.get(market) ?? null;
  }

  async #bot(accountId: string, clOrdID: string) {
    const [row] = await this.d.db
      .select({ order: orders, bot: bots, config: botVersions.config })
      .from(orders)
      .innerJoin(bots, eq(bots.id, orders.botId))
      .innerJoin(botVersions, eq(botVersions.id, bots.activeVersionId))
      .where(and(eq(orders.sodexAccountId, accountId), eq(orders.clOrdId, clOrdID)))
      .limit(1);
    return row;
  }

  async #book(botId: string): Promise<PaperBook | null> {
    const [a] = await this.d.db
      .select()
      .from(paperAccounts)
      .where(eq(paperAccounts.botId, botId))
      .limit(1);
    return a === undefined ? null : toBook(a);
  }

  async #engines(botId: string): Promise<Record<string, "spot" | "perps">> {
    const rows = await this.d.db
      .selectDistinct({ market: orders.market, engine: orders.engine })
      .from(orders)
      .where(eq(orders.botId, botId));
    return Object.fromEntries(rows.map((r) => [r.market, r.engine]));
  }

  async submit(
    account: AccountRef,
    list: readonly OrderIntent[],
    _fence: Fence,
    builderFeeRate?: number,
  ): Promise<SubmitResult[]> {
    assertPaper(account);
    const out: SubmitResult[] = [];
    for (const o of list) {
      // Paper chưa mô phỏng stop loss gốc của SoDEX (DEC-118): chiến lược tự giữ SL như trước.
      if (o.stop !== undefined) {
        out.push({ clOrdID: o.clOrdID, outcome: "rejected", code: "PAPER_NO_STOP", message: null });
        continue;
      }
      const row = await this.#bot(account.id, o.clOrdID);
      if (row?.bot.mode !== "paper") {
        out.push({ clOrdID: o.clOrdID, outcome: "rejected", code: "NOT_PAPER", message: null });
        continue;
      }
      const book = await this.#book(row.bot.id);
      if (book === null) {
        out.push({
          clOrdID: o.clOrdID,
          outcome: "rejected",
          code: "NO_PAPER_BALANCE",
          message: null,
        });
        continue;
      }
      const open = await this.d.db
        .select()
        .from(orders)
        .where(and(eq(orders.botId, row.bot.id), inArray(orders.status, [...OPEN])));
      const engines = { ...(await this.#engines(row.bot.id)), [o.market]: o.engine };
      const config = row.config as { leverage?: unknown };
      const leverage = typeof config.leverage === "number" ? config.leverage : 1;
      const fee = takerRate(
        o.engine,
        builderRateOnFill(o.engine, o.side, builderFeeRate ?? builderFeeRateOf(row.bot.strategy)),
      );
      const code = paperCheck({
        book,
        open: open.filter((x) => x.clOrdId !== o.clOrdID).map(toPaperOrder),
        order: { ...o, price: o.price },
        refPrice: this.priceOf(o.market),
        leverage,
        feeRate: fee,
        engines,
        prices: Object.fromEntries(this.#prices),
      });
      if (code !== null) {
        out.push({ clOrdID: o.clOrdID, outcome: "rejected", code, message: null });
        continue;
      }
      out.push({ clOrdID: o.clOrdID, outcome: "ok", orderId: this.#orderId++ });
    }
    return out;
  }

  cancel(account: AccountRef, list: readonly { clOrdID: string }[]): Promise<CancelResult[]> {
    assertPaper(account);
    return Promise.resolve(list.map((o) => ({ clOrdID: o.clOrdID, outcome: "ok" as const })));
  }

  async modifyStop(account: AccountRef): Promise<ModifyStopResult> {
    assertPaper(account);
    return Promise.resolve({ outcome: "rejected", code: "PAPER_NO_STOP" });
  }

  async lookup(account: AccountRef, o: { clOrdID: string }): Promise<LookupResult> {
    assertPaper(account);
    const row = await this.#bot(account.id, o.clOrdID);
    if (row === undefined) return { status: "not_found" };
    const s = row.order.status;
    const status =
      s === "open" ||
      s === "partially_filled" ||
      s === "filled" ||
      s === "cancelled" ||
      s === "rejected"
        ? s
        : "rejected";
    return {
      status,
      filledQty: row.order.filledSize,
      avgPrice: row.order.avgPrice,
      orderId: row.order.sodexOrderId ?? 0n,
    };
  }

  /** Fill mô phỏng nằm ở `paper_fills`; không trả về đây để không bao giờ bị ghi vào `fills`. */
  tradesOf(account: AccountRef): Promise<OrderTrade[]> {
    assertPaper(account);
    return Promise.resolve([]);
  }

  recentTrades(account: AccountRef): Promise<(OrderTrade & { clOrdID: string })[]> {
    assertPaper(account);
    return Promise.resolve([]);
  }

  /** Market Making không chạy paper; vị thế giả đọc từ `paper_accounts` ở API khi cần. */
  readPosition(account: AccountRef): Promise<{ size: string; entryPrice: string } | null> {
    assertPaper(account);
    return Promise.resolve(null);
  }

  setLeverage(account: AccountRef): Promise<LeverageResult> {
    assertPaper(account);
    return Promise.resolve({ outcome: "ok" });
  }

  readLeverage(
    account: AccountRef,
  ): Promise<{ setting: LeverageSetting | null; position: LeverageSetting | null }> {
    assertPaper(account);
    return Promise.resolve({ setting: null, position: null });
  }

  builderApproved(account: AccountRef): Promise<boolean> {
    assertPaper(account);
    return Promise.resolve(true);
  }

  /**
   * Giá mới của market: khớp các lệnh paper đang treo bị giá đi xuyên qua (market: khớp ở giá này ± trượt giá).
   * Ghi `paper_fills` + số dư giả trong một transaction mỗi lệnh; trả fill cho engine.
   */
  async onPrice(market: string, price: string, at: number): Promise<PaperFillEvent[]> {
    this.setPrice(market, price);
    const rows = await this.d.db
      .select({ order: orders, strategy: bots.strategy, ownRate: userBuilderFees.rate })
      .from(orders)
      .innerJoin(bots, eq(bots.id, orders.botId))
      // Builder fee riêng của user cho chiến lược (DEC-159), như lệnh thật.
      .leftJoin(
        userBuilderFees,
        and(eq(userBuilderFees.userId, bots.userId), eq(userBuilderFees.strategy, bots.strategy)),
      )
      .where(
        and(eq(bots.mode, "paper"), eq(orders.market, market), inArray(orders.status, [...OPEN])),
      );
    const out: PaperFillEvent[] = [];
    for (const { order: o, strategy, ownRate } of rows) {
      const intent = toPaperOrder(o);
      if (!paperCrosses(intent, price)) continue;
      const qty = dec(o.size).sub(o.filledSize);
      if (!qty.gt(0)) continue;
      const fillPrice = paperFillPrice(intent, price, this.d.slippage);
      const maker = o.type === "limit";
      const builder = builderRateOnFill(
        o.engine,
        o.side,
        builderFeeRateFor(strategy, ownRate === null ? undefined : { [strategy]: ownRate }),
      );
      const rate = maker ? makerRate(o.engine, builder) : takerRate(o.engine, builder);
      const fee = dec(fillPrice).mul(qty).mul(rate).toString();
      const done = await this.d.db.transaction(async (tx) => {
        const [a] = await tx
          .select()
          .from(paperAccounts)
          .where(eq(paperAccounts.botId, o.botId))
          .for("update");
        if (a === undefined) return false;
        const book = paperApplyFill(toBook(a), o, fillPrice, qty, fee);
        await tx
          .update(paperAccounts)
          .set({
            cash: book.cash,
            positions: book.positions,
            fees: book.fees,
            fills: book.fills,
            updatedAt: new Date(at),
          })
          .where(eq(paperAccounts.botId, o.botId));
        await tx.insert(paperFills).values({
          botId: o.botId,
          orderId: o.id,
          market: o.market,
          side: o.side,
          price: fillPrice,
          size: qty.toString(),
          fee,
          isMaker: maker,
          filledAt: new Date(at),
        });
        return true;
      });
      if (!done) continue;
      const total = dec(o.filledSize).add(qty);
      const avg =
        o.avgPrice === null
          ? dec(fillPrice)
          : dec(o.avgPrice).mul(o.filledSize).add(dec(fillPrice).mul(qty)).div(total);
      out.push({
        accountId: o.sodexAccountId,
        clOrdID: o.clOrdId,
        totalFilled: total.toString(),
        avgPrice: avg.toString(),
        fee,
      });
    }
    return out;
  }

  /** Funding của một kỳ cho vị thế perps giả của bot; trả số tiền (dương = trả). */
  async applyFunding(botId: string, market: string, rate: string, at: number): Promise<string> {
    const price = this.priceOf(market);
    if (price === null) return "0";
    return this.d.db.transaction(async (tx) => {
      const [a] = await tx
        .select()
        .from(paperAccounts)
        .where(eq(paperAccounts.botId, botId))
        .for("update");
      if (a === undefined) return "0";
      const r = paperFunding(toBook(a), market, price, rate);
      if (dec(r.amount).isZero()) return "0";
      await tx
        .update(paperAccounts)
        .set({ cash: r.book.cash, funding: r.book.funding, updatedAt: new Date(at) })
        .where(eq(paperAccounts.botId, botId));
      return r.amount;
    });
  }

  /** Số dư giả theo phút + đỉnh và sụt giảm lớn nhất (trang Fake-money test). */
  async snapshot(botId: string, at: number): Promise<void> {
    const [a] = await this.d.db
      .select()
      .from(paperAccounts)
      .where(eq(paperAccounts.botId, botId))
      .limit(1);
    if (a === undefined) return;
    const engines = await this.#engines(botId);
    const equity = paperEquity(toBook(a), engines, Object.fromEntries(this.#prices));
    const peak = Decimal.max(dec(a.peakEquity), equity);
    const dd = Decimal.max(dec(a.maxDrawdown), peak.sub(equity));
    const minute = new Date(at - (at % 60_000));
    await this.d.db
      .insert(paperSnapshots)
      .values({ botId, at: minute, equity: equity.toString() })
      .onConflictDoUpdate({
        target: [paperSnapshots.botId, paperSnapshots.at],
        set: { equity: sql`excluded.equity` },
      });
    await this.d.db
      .update(paperAccounts)
      .set({ peakEquity: peak.toString(), maxDrawdown: dd.toString() })
      .where(eq(paperAccounts.botId, botId));
  }
}

function toBook(a: typeof paperAccounts.$inferSelect): PaperBook {
  return {
    cash: dec(a.cash).toString(),
    positions: (a.positions ?? {}) as PaperBook["positions"],
    fees: dec(a.fees).toString(),
    funding: dec(a.funding).toString(),
    fills: a.fills,
  };
}

function toPaperOrder(o: typeof orders.$inferSelect): PaperOrder {
  return {
    market: o.market,
    engine: o.engine,
    side: o.side,
    type: o.type,
    price: o.price ?? undefined,
    quantity: dec(o.size).sub(o.filledSize).toString(),
    timeInForce: o.timeInForce,
    reduceOnly: o.reduceOnly,
  };
}

/** Phí mô phỏng = phí cơ bản của SoDEX + builder fee trên lần khớp (tỷ lệ thô; Spot mua không có builder fee). */
function makerRate(engine: "spot" | "perps", builder: number): string {
  return pct(SODEX_BASE_FEE_PCT[engine].maker).add(feeRateToFraction(builder)).toString();
}
function takerRate(engine: "spot" | "perps", builder: number): string {
  return pct(SODEX_BASE_FEE_PCT[engine].taker).add(feeRateToFraction(builder)).toString();
}
