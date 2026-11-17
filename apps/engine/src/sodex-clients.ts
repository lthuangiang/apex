import {
  SignedWriteClient,
  SodexRestClient,
  type FetchLike,
  type RateLimitStore,
  type SodexCallRecorderLike,
  type SodexConfig,
} from "@drift/sodex";

// Client SoDEX của engine (DEC-310). Lời gọi chỉ đọc không nằm trên đường gửi lệnh (sổ lệnh, quy tắc
// market cho chiến lược, approval, tra lệnh, lịch sử khớp, vị thế) lấy token của bucket IP với mức dự trữ
// `BACKGROUND_RESERVE` (30%): khi bucket xuống dưới mức đó thì lời gọi bị bỏ (lỗi RATE_LIMITED, bước đó thử lại ở lượt sau),
// không rút cạn phần của lệnh ghi. Lệnh ghi (đặt / huỷ / đóng / dời stop / đòn bẩy) và lời gọi đọc NGAY TRƯỚC khi gửi
// (id symbol của `HttpGateway`, đòn bẩy hiện tại) dùng mức thường: không bị phần dự trữ chặn.

export interface EngineSodexOptions {
  config: Pick<SodexConfig, "restUrl" | "restWeightPerMinute">;
  rateLimit: RateLimitStore;
  egressKey: string;
  fetch?: FetchLike;
  /** SoDEX Debugger (DEC-309): ghi mọi lời gọi của cả bốn client. */
  recorder?: SodexCallRecorderLike;
  /** Timeout mỗi lời gọi đọc của đối soát (tra lệnh, lịch sử khớp, vị thế). */
  readTimeoutMs: number;
}

/** Đếm lời gọi đọc nền bị phần dự trữ chặn (store trả `allowed: false`), để log mỗi phút. */
class CountingStore implements RateLimitStore {
  skipped = 0;
  constructor(private readonly inner: RateLimitStore) {}
  async take(...args: Parameters<RateLimitStore["take"]>): ReturnType<RateLimitStore["take"]> {
    const result = await this.inner.take(...args);
    if (!result.allowed) this.skipped += 1;
    return result;
  }
}

export function engineSodexClients(o: EngineSodexOptions): {
  /** Đọc trên đường gửi lệnh (id symbol, đòn bẩy hiện tại): mức thường, không có phần dự trữ. */
  orderPath: SodexRestClient;
  /** Đọc nền của engine (quy tắc market cho chiến lược, sổ lệnh), chừa phần dự trữ cho lệnh ghi. */
  rest: SodexRestClient;
  /** Đọc của đối soát và approval, chừa phần dự trữ, timeout ngắn hơn. */
  reads: SodexRestClient;
  writer: SignedWriteClient;
  /** Số lời gọi đọc nền bị bỏ vì phần dự trữ kể từ lần gọi trước (rồi về 0). */
  takeSkipped: () => number;
} {
  const counting = new CountingStore(o.rateLimit);
  const base = {
    config: o.config,
    rateLimit: o.rateLimit,
    egressKey: o.egressKey,
    ...(o.fetch === undefined ? {} : { fetch: o.fetch }),
    ...(o.recorder === undefined ? {} : { recorder: o.recorder }),
  };
  const background = { ...base, rateLimit: counting, priority: "background" as const };
  return {
    orderPath: new SodexRestClient(base),
    rest: new SodexRestClient(background),
    reads: new SodexRestClient({ ...background, timeoutMs: o.readTimeoutMs }),
    writer: new SignedWriteClient(base),
    takeSkipped: () => {
      const n = counting.skipped;
      counting.skipped = 0;
      return n;
    },
  };
}
