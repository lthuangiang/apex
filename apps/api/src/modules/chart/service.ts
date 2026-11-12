import {
  AppError,
  ErrorCode,
  type CandleList,
  type ChartInterval,
  type LiquidationMap,
  ORDERBOOK_DEPTH,
  type OrderbookView,
} from "@drift/shared";
import type { SodexRestClient } from "@drift/sodex";

// Chart ở màn tạo bot (IMPROVEMENTS IMP-05, DEC-91). Nến lấy từ SoDEX qua server, có cache theo market và
// khung thời gian để nhiều người mở cùng market không nhân số request lên SoDEX. Bản đồ thanh lý đi qua
// `LiquidationProvider`: chưa cấu hình nhà cung cấp thì `available: false` và UI ẩn tab. Dữ liệu thanh lý chỉ
// để hiển thị, không được đưa vào strategy, reco hay quyết định đặt lệnh.

/** Số nến mỗi lần lấy: đủ cho khung nhìn mặc định của chart, nhỏ để giữ weight rate limit thấp. */
export const CANDLE_LIMIT = 200;

/** Thời gian cache theo khung: nến 15m đổi nhanh hơn nến 1D. */
const TTL_MS: Record<ChartInterval, number> = {
  "15m": 30_000,
  "1h": 60_000,
  "4h": 300_000,
  "1d": 300_000,
};

/** Bảng cache nhỏ có hạn kích thước; quá hạn mức thì bỏ mục cũ nhất (Map giữ thứ tự chèn). */
export class TtlCache<T> {
  readonly #items = new Map<string, { at: number; value: Promise<T> }>();
  constructor(readonly maxEntries: number) {}

  get(key: string, ttlMs: number, now: number, load: () => Promise<T>): Promise<T> {
    const hit = this.#items.get(key);
    if (hit !== undefined && now - hit.at < ttlMs) return hit.value;
    const value = load();
    this.#items.delete(key);
    this.#items.set(key, { at: now, value });
    // Lỗi không được cache: lần sau thử lại.
    value.catch(() => {
      if (this.#items.get(key)?.value === value) this.#items.delete(key);
    });
    while (this.#items.size > this.maxEntries) {
      const oldest = this.#items.keys().next().value;
      if (oldest === undefined) break;
      this.#items.delete(oldest);
    }
    return value;
  }
}

/** Một dải thanh lý ước tính: mức giá và giá trị (quote). Decimal string. */
export interface LiquidationBand {
  price: string;
  value: string;
}

/**
 * Nhà cung cấp bản đồ thanh lý. Bản cài thật chỉ được thêm khi chủ dự án đã chọn nhà cung cấp có API và giấy
 * phép cho phép hiển thị lại cho khách (IMP-05). Không lấy dữ liệu từ trang web, không gọi endpoint nội bộ.
 */
export interface LiquidationProvider {
  /** Tên hiển thị để ghi nguồn. */
  readonly name: string;
  /** Null khi nhà cung cấp không có dữ liệu cho market này. */
  get(
    market: string,
    interval: ChartInterval,
  ): Promise<{ bands: LiquidationBand[]; updatedAt: number } | null>;
}

export interface ChartDeps {
  rest: Pick<SodexRestClient, "getKlines" | "getOrderbook">;
  /** Null: chưa cấu hình nhà cung cấp (mặc định). */
  liquidations: LiquidationProvider | null;
  now: () => Date;
}

const INTERVAL_MS: Record<ChartInterval, number> = {
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

export function createChartService(deps: ChartDeps) {
  const candles = new TtlCache<CandleList["items"]>(500);
  const liq = new TtlCache<LiquidationMap>(500);
  const books = new TtlCache<OrderbookView>(50);
  return {
    /**
     * Sổ lệnh Perps cho Trading Agent của Market Making (DEC-99). Cache 1 s theo market để nhiều người xem
     * cùng lúc chỉ tốn một request SoDEX mỗi giây.
     */
    async orderbook(market: string): Promise<OrderbookView> {
      const now = deps.now().getTime();
      return books
        .get(market, 1_000, now, async () => {
          const b = await deps.rest.getOrderbook("perps", market, ORDERBOOK_DEPTH);
          const side = (rows: readonly (readonly [string, string])[]) =>
            rows.slice(0, ORDERBOOK_DEPTH).map(([price, size]) => ({ price, size }));
          return { market, at: now, bids: side(b.bids), asks: side(b.asks) };
        })
        .catch((error: unknown) => {
          if (error instanceof AppError) throw error;
          throw new AppError(
            ErrorCode.sodexUnavailable,
            "Can't load the order book from SoDEX right now.",
          );
        });
    },

    async candles(
      engine: "spot" | "perps",
      market: string,
      interval: ChartInterval,
    ): Promise<CandleList> {
      const now = deps.now().getTime();
      const items = await candles
        .get(`${engine}:${market}:${interval}`, TTL_MS[interval], now, async () => {
          const k = await deps.rest.getKlines(engine, market, {
            interval,
            startTime: now - CANDLE_LIMIT * INTERVAL_MS[interval],
            endTime: now,
            limit: CANDLE_LIMIT,
          });
          // SoDEX trả mới nhất trước; chart cần cũ nhất trước và không trùng thời điểm.
          const byT = new Map(k.map((c) => [c.t, { t: c.t, o: c.o, h: c.h, l: c.l, c: c.c }]));
          return [...byT.values()].sort((a, b) => a.t - b.t);
        })
        .catch((error: unknown) => {
          if (error instanceof AppError) throw error;
          throw new AppError(
            ErrorCode.sodexUnavailable,
            "Can't load candles from SoDEX right now.",
          );
        });
      return { market, interval, items };
    },

    async liquidations(market: string, interval: ChartInterval): Promise<LiquidationMap> {
      const provider = deps.liquidations;
      const none: LiquidationMap = {
        market,
        interval,
        available: false,
        source: null,
        updatedAt: null,
        bands: [],
      };
      if (provider === null) return none;
      return liq.get(`${market}:${interval}`, TTL_MS[interval], deps.now().getTime(), async () => {
        // Nhà cung cấp lỗi thì coi như không có dữ liệu: tab ẩn, chart giá vẫn dùng được.
        const data = await provider.get(market, interval).catch(() => null);
        if (data === null || data.bands.length === 0) return none;
        return {
          market,
          interval,
          available: true,
          source: provider.name,
          updatedAt: data.updatedAt,
          bands: data.bands,
        };
      });
    },
  };
}

export type ChartService = ReturnType<typeof createChartService>;
