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
  /** Rate limit API mỗi phút (C12); E2E nâng lên vì mọi request đến từ cùng một IP. */
  API_RATE_LIMIT_PER_IP: z.coerce.number().int().positive().default(600),
  API_RATE_LIMIT_PER_USER: z.coerce.number().int().positive().default(300),
  MAIL_FROM: z.string().min(1),
  /**
   * Nguồn bản đồ thanh lý (IMP-05, DEC-92). `none`: tab Liquidation map ẩn. `hyperliquid`: `marketdata` quét
   * dữ liệu công khai của Hyperliquid, api đọc từ Redis.
   */
  LIQUIDATION_PROVIDER: z.enum(["none", "hyperliquid"]).default("none"),
  /** URL và key API của nhà cung cấp; chỉ ở server, không gửi xuống trình duyệt. */
  LIQUIDATION_API_URL: z.url().optional(),
  LIQUIDATION_API_KEY: z.string().min(1).optional(),
  /** Copy Trading (DEC-163): ngưỡng USD cảnh báo big move; trống = tắt (OPEN_QUESTIONS 21a). */
  COPY_BIG_MOVE_MIN_USD: z
    .string()
    .regex(/^\d+(\.\d+)?$/)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  /** Notifications v2: kênh Telegram (DEC-170). Tắt thì mọi route `/api/v1/telegram/*` trả 404. */
  TELEGRAM_ENABLED: z.stringbool().default(false),
  DRIFT_TELEGRAM_BOT_USERNAME: z
    .string()
    .regex(/^[A-Za-z0-9_]{5,32}$/)
    .default("desklabsbot"),
  /** Bot token (production: Vault). Không bao giờ log; nằm trong URL Bot API nên URL cũng phải che. */
  DRIFT_TELEGRAM_BOT_TOKEN: emptyToUndefined(z.string().min(20)),
  /** Giá trị header `X-Telegram-Bot-Api-Secret-Token` (Telegram cho phép `[A-Za-z0-9_-]`, 1–256 ký tự). */
  DRIFT_TELEGRAM_WEBHOOK_SECRET: emptyToUndefined(z.string().regex(/^[A-Za-z0-9_-]{32,256}$/)),
  /** Gốc URL của web app cho nút "Open DeskLabs" trong tin Telegram. */
  DRIFT_APP_URL: z.url().default("https://desklabs.xyz"),
  /** Desk AI (DEC-165, DEC-188): key Claude API; trống = LLM tắt, Desk AI dùng câu mẫu. Không log. */
  DESK_AI_API_KEY: z
    .string()
    .min(1)
    .optional()
    .or(z.literal("").transform(() => undefined)),
});

function emptyToUndefined<T extends z.ZodType>(schema: T) {
  return schema.optional().or(z.literal("").transform(() => undefined));
}

export type ApiConfig = z.infer<typeof envSchema> & { sodex: SodexConfig };

export function loadApiConfig(env: Record<string, string | undefined>): ApiConfig {
  const parsed = envSchema.parse(env);
  // Bật Telegram mà thiếu token hoặc secret thì không khởi động (CODING_STANDARDS C2).
  if (
    parsed.TELEGRAM_ENABLED &&
    (parsed.DRIFT_TELEGRAM_BOT_TOKEN === undefined ||
      parsed.DRIFT_TELEGRAM_WEBHOOK_SECRET === undefined)
  ) {
    throw new Error(
      "TELEGRAM_ENABLED=true needs DRIFT_TELEGRAM_BOT_TOKEN and DRIFT_TELEGRAM_WEBHOOK_SECRET.",
    );
  }
  return { ...parsed, sodex: loadSodexConfig(env) };
}
