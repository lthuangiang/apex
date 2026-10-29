import type { BucketSpec } from "./token-bucket";

// Hạn mức công khai của SoDEX (docs/ARCHITECTURE.md mục 3.3.6, docs/SODEX.md mục 5.6).

/** REST: 1200 weight mỗi phút trên mỗi IP egress. */
export const IP_REST_BUCKET: BucketSpec = { capacity: 1200, refill: 1200, intervalMs: 60_000 };

/** Bucket IP theo cấu hình (`SODEX_REST_WEIGHT_PER_MIN`); không cấu hình thì đúng hạn mức của SoDEX. */
export function ipBucket(perMinute?: number): BucketSpec {
  return perMinute === undefined
    ? IP_REST_BUCKET
    : { capacity: perMinute, refill: perMinute, intervalMs: 60_000 };
}

/** Lệnh: 20 lệnh/giây và 600 lệnh/phút trên mỗi API key; mỗi lệnh trong batch tính riêng. */
export const KEY_ORDERS_PER_SECOND: BucketSpec = { capacity: 20, refill: 20, intervalMs: 1000 };
export const KEY_ORDERS_PER_MINUTE: BucketSpec = { capacity: 600, refill: 600, intervalMs: 60_000 };

/** Trọng số theo endpoint; endpoint không liệt kê tính 20. */
export const RestWeight = {
  marketInfo: 2,
  accountRead: 5,
  publicUserRead: 20,
  default: 20,
} as const;

/** Batch đặt / huỷ / thay lệnh: 1 + floor(N / 40). */
export function orderBatchWeight(count: number): number {
  return 1 + Math.floor(count / 40);
}

/** Kline: 20 + max(1, floor(rows / 25)). */
export function klineWeight(rows: number): number {
  return 20 + Math.max(1, Math.floor(rows / 25));
}
