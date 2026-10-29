import { z } from "zod";

// Config SoDEX đọc từ env, parse bằng zod (CODING_STANDARDS C2).

const UINT64_MAX = 2n ** 64n - 1n;

/** uint64 dạng chuỗi số nguyên dương, giữ dưới dạng bigint để không mất chính xác. */
export const positiveUint64EnvSchema = z
  .string()
  .regex(/^[1-9]\d*$/, { message: "Expected a positive integer" })
  .transform((value) => BigInt(value))
  .refine((value) => value <= UINT64_MAX, { message: "Out of uint64 range" });

export const sodexEnvSchema = z.object({
  SODEX_REST_URL: z.url({ protocol: /^https$/ }),
  SODEX_WS_URL: z.url({ protocol: /^wss$/ }),
  // DEC-23: mọi môi trường dùng mainnet.
  SODEX_CHAIN: z.literal("mainnet"),
  // DEC-24: bắt buộc, không có mặc định.
  DRIFT_BUILDER_ID: positiveUint64EnvSchema,
  /**
   * Hạn mức REST tự đặt trên mỗi IP egress (weight/phút). Mặc định đúng hạn mức công khai của SoDEX (1200);
   * chỉ nâng khi chạy với SoDEX mock (E2E), không bao giờ cho mainnet.
   */
  SODEX_REST_WEIGHT_PER_MIN: z.coerce.number().int().positive().default(1200),
});

export interface SodexConfig {
  restUrl: string;
  wsUrl: string;
  chain: "mainnet";
  builderId: bigint;
  restWeightPerMinute?: number;
}

export function loadSodexConfig(env: Record<string, string | undefined>): SodexConfig {
  const parsed = sodexEnvSchema.parse(env);
  return {
    restUrl: parsed.SODEX_REST_URL.replace(/\/+$/, ""),
    wsUrl: parsed.SODEX_WS_URL.replace(/\/+$/, ""),
    chain: parsed.SODEX_CHAIN,
    builderId: parsed.DRIFT_BUILDER_ID,
    restWeightPerMinute: parsed.SODEX_REST_WEIGHT_PER_MIN,
  };
}
