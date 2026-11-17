import {
  SignedWriteClient,
  SodexRestClient,
  type FetchLike,
  type RateLimitStore,
  type SodexConfig,
} from "@drift/sodex";

// Client SoDEX của engine (DEC-TBD-engine-rest-budget). Mọi lời gọi chỉ đọc của engine (thông tin market, sổ lệnh, đòn bẩy,
// approval, tra lệnh, lịch sử khớp, vị thế) lấy token của bucket IP với mức dự trữ `BACKGROUND_RESERVE` (30%): khi bucket
// xuống dưới mức đó thì lời gọi đọc bị bỏ (lỗi RATE_LIMITED, bước đó thử lại ở lượt sau), không bao giờ rút cạn phần của
// lệnh ghi. Lệnh ghi (đặt / huỷ / đóng / dời stop / đòn bẩy) không có mức dự trữ, nên luôn còn chỗ.

export interface EngineSodexOptions {
  config: Pick<SodexConfig, "restUrl" | "restWeightPerMinute">;
  rateLimit: RateLimitStore;
  egressKey: string;
  fetch?: FetchLike;
  /** Timeout mỗi lời gọi đọc của đối soát (tra lệnh, lịch sử khớp, vị thế). */
  readTimeoutMs: number;
}

export function engineSodexClients(o: EngineSodexOptions): {
  /** Đọc thường của engine (market, sổ lệnh, đòn bẩy, approval). */
  rest: SodexRestClient;
  /** Đọc của đối soát, timeout ngắn hơn. */
  reads: SodexRestClient;
  writer: SignedWriteClient;
} {
  const base = {
    config: o.config,
    rateLimit: o.rateLimit,
    egressKey: o.egressKey,
    ...(o.fetch === undefined ? {} : { fetch: o.fetch }),
  };
  return {
    rest: new SodexRestClient({ ...base, priority: "background" }),
    reads: new SodexRestClient({ ...base, priority: "background", timeoutMs: o.readTimeoutMs }),
    writer: new SignedWriteClient(base),
  };
}
