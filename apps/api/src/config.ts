import { loadSodexConfig, type SodexConfig } from "@drift/sodex";
import { z } from "zod";

// Env của api, parse bằng zod (CODING_STANDARDS C2). Thiếu biến bắt buộc thì không khởi động.

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  API_PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().min(1),
  /** 32 byte base64: khoá AES-256-GCM mã hoá secret TOTP (DEC-29). */
  API_TOTP_ENC_KEY: z
    .string()
    .refine((v) => Buffer.from(v, "base64").length === 32, { message: "Expected 32 bytes base64" }),
  /** Cookie `Secure` tắt chỉ khi chạy http://localhost trong dev/test. */
  API_COOKIE_SECURE: z.stringbool().default(true),
  SMTP_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  SIGNER_URL: z.url(),
  /** Service engine đề xuất (RECO_ENGINE.md mục 10). */
  RECO_URL: z.url(),
  /** IP egress của replica này, làm khoá bucket rate limit SoDEX. */
  SODEX_EGRESS_KEY: z.string().min(1).default("default"),
  /** Tắt cho tới khi mặt nạ 14 được kiểm chứng trên mainnet (SODEX.md mục 5.2). */
  SODEX_CONNECT_ENABLED: z.stringbool().default(false),
  /** Chỉ bật khi có xác nhận bằng văn bản của SoDEX (VOLUME_MAKER.md mục 17.5). */
  VOLUME_MAKER_ENABLED: z.stringbool().default(false),
  /** Rate limit API mỗi phút (C12); E2E nâng lên vì mọi request đến từ cùng một IP. */
  API_RATE_LIMIT_PER_IP: z.coerce.number().int().positive().default(600),
  API_RATE_LIMIT_PER_USER: z.coerce.number().int().positive().default(300),
  MAIL_FROM: z.string().min(1),
});

export type ApiConfig = z.infer<typeof envSchema> & { sodex: SodexConfig };

export function loadApiConfig(env: Record<string, string | undefined>): ApiConfig {
  return { ...envSchema.parse(env), sodex: loadSodexConfig(env) };
}
