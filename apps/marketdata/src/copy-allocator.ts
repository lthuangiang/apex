import {
  allocateCopy,
  dec,
  Decimal,
  LEADER_STATS,
  type BookLevel,
  type CopyDemand,
  type LeaderFillMessage,
  type LeaderSource,
} from "@drift/shared";

// Hạn mức cho tín hiệu mở / tăng của leader (DEC-163 mục 5 và 9), tính ở marketdata trước khi publish:
// - minHoldFilter: trader có thống kê và typical hold < 15 phút → mọi bot hạn mức 0 (`min_hold`); giảm / đóng vẫn đi.
// - Thanh khoản: tổng notional của mọi bot copy cùng leader × market ≤ 50% độ sâu sổ SoDEX phía bot sẽ ăn, trong khoảng
//   Max price move. Bot follow và inverse ăn hai phía khác nhau nên phân bổ riêng.
// Lỗi đọc sổ lệnh → không publish hạn mức thanh khoản sẽ vượt kiểm soát, nên trả hạn mức 0 cho mọi bot (an toàn).

export interface AllocatorBot {
  botId: string;
  source: LeaderSource;
  address: string;
  config: Record<string, unknown>;
}

export interface CopyAllocatorDeps {
  bots(): Promise<AllocatorBot[]>;
  /** Typical hold (ms) mới nhất theo ví Hyperliquid; ví chưa có thống kê không có trong map. */
  holds(addresses: readonly string[]): Promise<Map<string, number | null>>;
  orderbook(market: string): Promise<{ bids: BookLevel[]; asks: BookLevel[] }>;
  warn(detail: object, message: string): void;
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** Notional (USD) một bot muốn dùng cho tín hiệu (cận trên, đã cắt `maxNotionalPerTrade`). */
export function demandOf(
  config: Record<string, unknown>,
  opening: boolean,
  leaderAbs: Decimal,
  price: Decimal,
): Decimal {
  const cap = dec(str(config.maxNotionalPerTrade) ?? "0");
  if (!opening) return cap;
  const want =
    config.sizing === "ratio"
      ? leaderAbs
          .mul(dec(str(config.ratioPct) ?? "0"))
          .div(100)
          .mul(price)
      : dec(str(config.fixedNotional) ?? "0");
  return Decimal.min(want, cap);
}

const marketsOf = (c: Record<string, unknown>): string[] =>
  Array.isArray(c.markets)
    ? c.markets.filter((m): m is string => typeof m === "string")
    : typeof c.market === "string"
      ? [c.market]
      : [];

export class CopyAllocator {
  readonly #d: CopyAllocatorDeps;
  #bots: AllocatorBot[] = [];
  #holds = new Map<string, number | null>();

  constructor(deps: CopyAllocatorDeps) {
    this.#d = deps;
  }

  /** Đọc lại danh sách bot copy và typical hold (mỗi vòng sync 30 s). */
  async refresh(): Promise<void> {
    this.#bots = await this.#d.bots();
    const hl = [
      ...new Set(this.#bots.filter((b) => b.source === "hyperliquid").map((b) => b.address)),
    ];
    this.#holds = await this.#d.holds(hl);
  }

  async enrich(m: LeaderFillMessage): Promise<LeaderFillMessage> {
    const after = dec(m.positionAfter);
    const before = after.sub(dec(m.quantity).mul(m.side === "buy" ? 1 : -1));
    const opening =
      before.isZero() || (!after.isZero() && before.isNegative() !== after.isNegative());
    const increasing =
      !opening &&
      !before.isZero() &&
      after.abs().gt(before.abs()) &&
      before.isNegative() === after.isNegative();
    if (!opening && !increasing) return m;

    const bots = this.#bots.filter(
      (b) =>
        b.source === m.source &&
        b.address === m.address.toLowerCase() &&
        marketsOf(b.config).includes(m.market),
    );
    if (bots.length === 0) return m;

    if (m.source === "hyperliquid" && this.#holds.has(m.address.toLowerCase())) {
      const hold = this.#holds.get(m.address.toLowerCase()) ?? null;
      if (hold === null || hold < LEADER_STATS.minHoldMs)
        return {
          ...m,
          allowances: Object.fromEntries(bots.map((b) => [b.botId, "0"])),
          allowanceReason: "min_hold",
        };
    }

    let book: { bids: BookLevel[]; asks: BookLevel[] };
    try {
      book = await this.#d.orderbook(m.market);
    } catch (error) {
      this.#d.warn(
        { err: error, market: m.market },
        "orderbook read failed; copies skip this signal",
      );
      return {
        ...m,
        allowances: Object.fromEntries(bots.map((b) => [b.botId, "0"])),
        allowanceReason: "liquidity",
      };
    }
    const bid = book.bids[0]?.[0];
    const ask = book.asks[0]?.[0];
    if (bid === undefined || ask === undefined)
      return {
        ...m,
        allowances: Object.fromEntries(bots.map((b) => [b.botId, "0"])),
        allowanceReason: "liquidity",
      };
    const ref = dec(bid).add(dec(ask)).div(2).toString();
    const price = dec(m.price);
    // Leader mua: bot follow mua (ăn asks), bot inverse bán (ăn bids).
    const groups = new Map<"buy" | "sell", CopyDemand[]>();
    for (const b of bots) {
      const follow = b.config.direction !== "inverse";
      const side: "buy" | "sell" = (m.side === "buy") === follow ? "buy" : "sell";
      const list = groups.get(side) ?? [];
      list.push({
        botId: b.botId,
        desired: demandOf(b.config, opening, after.abs(), price).toString(),
        maxSlippagePct: str(b.config.maxSlippagePct) ?? "0.3",
      });
      groups.set(side, list);
    }
    let allowances: Record<string, string> | null = null;
    for (const [side, demands] of groups) {
      const a = allocateCopy(demands, side === "buy" ? book.asks : book.bids, side, ref);
      if (a === null) continue;
      allowances = { ...(allowances ?? {}), ...a };
    }
    if (allowances === null) return m;
    // Bot nhóm không cần cắt vẫn nhận đủ phần mình (nếu không có trong map sẽ thành 0 ở engine).
    for (const b of bots)
      if (!(b.botId in allowances))
        allowances[b.botId] = demandOf(b.config, opening, after.abs(), price).toString();
    return { ...m, allowances, allowanceReason: "liquidity" };
  }
}
