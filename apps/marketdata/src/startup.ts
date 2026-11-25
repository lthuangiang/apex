// #531: thứ tự phần còn lại của `start()` sau khi stream WS đã mở.
// - Theo dõi ví leader (Copy Trading SoDEX `leaders.sync` + copy allocator, Hyperliquid sync / poll 2 phút / flush) KHÔNG
//   phụ thuộc lần đọc lại nến REST, nên được bật NGAY.
// - Backfill nến chạy NỀN, không chặn `start()`; `stop()` (mất leader / start lỗi) huỷ nó, để lần lên leader sau không
//   chạy chồng hai backfill.
// Trước đây mọi thứ trên chỉ được bật sau `await backfill(…)`. Backfill đọc klines tuần tự cho mọi symbol qua client nền
// (bucket IP còn trên 30% mới lấy token), nên khi bucket thiếu, nó chạy hơn 10 giờ và ví leader không được theo dõi
// (prod 2026-11-24 09:02 UTC → bản sửa). Hàm thuần để test được thứ tự mà không dựng cả marketdata.

/** Cờ huỷ của một lần backfill: kiểm giữa hai symbol. */
export interface CancelFlag {
  readonly cancelled: boolean;
}

export interface BackfillResult {
  symbols: number;
  failed: number;
  /** Dừng giữa chừng vì `stop()`. */
  cancelled: boolean;
}

export interface LeaderStartupSteps {
  /** Bật theo dõi ví leader (đồng bộ: chạy lần đầu + đăng ký timer). */
  startLeaderFeeds: () => void;
  /** Đọc lại nến REST; phải kiểm `flag.cancelled` giữa hai symbol. */
  backfill: (flag: CancelFlag) => Promise<BackfillResult>;
  now: () => number;
  info: (detail: object, message: string) => void;
  warn: (detail: object, message: string) => void;
}

/** Bật theo dõi ví leader ngay, rồi chạy backfill nền. Trả hàm huỷ backfill (gọi trong `stop()`). */
export function startLeaderFeedsThenBackfill(s: LeaderStartupSteps): () => void {
  s.startLeaderFeeds();
  const flag = { cancelled: false };
  const t0 = s.now();
  void s
    .backfill(flag)
    .then((r) => {
      const detail = { ms: s.now() - t0, symbols: r.symbols, failed: r.failed };
      if (r.cancelled) s.info(detail, "marketdata backfill cancelled");
      else s.info(detail, "marketdata backfill done");
    })
    .catch((error: unknown) => {
      s.warn({ err: error }, "marketdata backfill stopped");
    });
  return () => {
    flag.cancelled = true;
  };
}

/** Chạy `read` cho từng symbol theo thứ tự, dừng khi cờ huỷ bật; lỗi của một symbol chỉ được đếm. */
export async function backfillSymbols(
  symbols: readonly string[],
  flag: CancelFlag,
  read: (symbol: string) => Promise<void>,
  onError: (symbol: string, error: unknown) => void,
): Promise<BackfillResult> {
  let failed = 0;
  let done = 0;
  for (const symbol of symbols) {
    if (flag.cancelled) return { symbols: done, failed, cancelled: true };
    try {
      await read(symbol);
    } catch (error) {
      failed += 1;
      onError(symbol, error);
    }
    done += 1;
  }
  return { symbols: done, failed, cancelled: flag.cancelled };
}
