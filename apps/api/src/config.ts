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
  /**
   * #420: bot `news_signal` chạy tiền thật trên SoDEX mainnet. Tắt (mặc định) thì tạo bot / Start / Resume trả 409
   * `FEATURE_NOT_READY` cho mọi người. Người dùng tự bật sau khi engine nối tín hiệu và đã thử lệnh nhỏ thật.
   */
  SIGNAL_NEWS_BOTS_ENABLED: z.stringbool().default(false),
  /**
   * #546 / DEC-397: công tắc toàn hệ thống của SoDEX rewards (mục sidebar Rewards, thẻ Overview, route `/rewards`), trả
   * về web qua `GET /api/v1/features` (`sodexRewards`) để đổi lúc chạy mà không build lại image web. Mặc định BẬT cho mọi
   * user từ bản sau #575 (quyết định của chủ sản phẩm 2026-11-27, DEC-397 bổ sung); biến chỉ còn là nút tắt khẩn khi
   * gateway SoDEX có sự cố (`REWARDS_ENABLED=false`: user thường không thấy, team vẫn thấy). Trang chẩn đoán
   * `/admin/rewards-debug` (team) không phụ thuộc công tắc này.
   */
  REWARDS_ENABLED: z.stringbool().default(true),
  /**
   * #558 / DEC-398: báo box mới SoDEX rewards (nhận phiên rewards để scheduler đọc định kỳ). Mặc định tắt; PR1 chỉ khai
   * báo cờ, route `rewards/watch` (PR3) đọc cờ này. Cùng giá trị với scheduler.
   */
  REWARDS_WATCH_ENABLED: z.stringbool().default(false),
  /**
   * #558 (DEC-398): giá trị `aud` của JWT rewards được phép lưu ở server, cách nhau bằng dấu phẩy. Mọi giá trị `aud` của
   * token phải nằm trong danh sách. Trống (mặc định) = từ chối mọi token: PM đặt sau khi xem `aud` trên
   * `/admin/rewards-debug`; `aud` cho thấy token dùng được cho giao dịch thì không đặt.
   */
  REWARDS_JWT_AUD_ALLOW: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== ""),
    ),
  /** #558: trần riêng weight / phút của lời gọi gateway rewards từ server (bucket `rl:sodex:rewards:<egress>`). */
  REWARDS_WATCH_MAX_WEIGHT_PER_MIN: z.coerce.number().int().positive().default(120),
  /** #558: origin gateway rewards cho server (trống = mainnet; client chỉ nhận https). */
  SODEX_REWARDS_GATEWAY: z.string().default(""),
  /**
   * #589 / DEC-402 mục 9: US Market + SoDEX Wealth (banner Strategy Lab, `/markets/us`, Portfolio › My Wealth). Mặc định
   * BẬT; tắt thì `/api/v1/markets/us`, `/api/v1/wealth/me` trả 404 và `/api/v1/features.usMarket` = false. Giới hạn theo
   * sổ lệnh của bot (DEC-402 mục 5) không phụ thuộc công tắc này.
   */
  US_MARKET_ENABLED: z.stringbool().default(true),
  /**
   * #590 (DEC-402 bổ sung 2026-11-28): market áp giới hạn theo sổ lệnh lúc tạo / sửa bot. Thiếu hoặc `default` = danh sách
   * mặc định (ANT + 8 cặp token quỹ); chuỗi trống = tắt hẳn; `*` = mọi market; còn lại = danh sách phân cách dấu phẩy.
   * Engine đọc cùng biến; đặt cùng một giá trị cho hai service.
   */
  DEPTH_CAP_MARKETS: z.string().optional(),
  /**
   * #594 / DEC-404: cảnh báo SoDEX Wealth (công tắc "Alerts" ở My Wealth, nhóm thông báo `wealth`). Mặc định TẮT: chưa
   * thấy giá trị enum trên dữ liệu thật; tắt thì user thường không thấy công tắc, role team vẫn dùng được để thử. Cùng
   * giá trị với scheduler.
   */
  WEALTH_WATCH_ENABLED: z.stringbool().default(false),
  /** #589: trần riêng weight / phút của lời gọi Wealth API từ api (bucket `rl:sodex:wealth:<egress>`; mỗi lời gọi 20). */
  WEALTH_READ_MAX_WEIGHT_PER_MIN: z.coerce.number().int().positive().default(400),
  /** Notifications v2: kênh Telegram (DEC-170). Tắt thì mọi route `/api/v1/telegram/*` trả 404. */
  TELEGRAM_ENABLED: z.stringbool().default(false),
  /** Morning brief qua Telegram (N4): chỉ chạy khi TELEGRAM_ENABLED cũng bật. */
  TELEGRAM_BRIEF_ENABLED: z.stringbool().default(true),
  /** true: chưa có báo cáo sáng thì tạo bằng Desk AI (gọi LLM). Mặc định false: câu mẫu (DEC-194). */
  TELEGRAM_BRIEF_LLM: z.stringbool().default(false),
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
  /** MCP (DEC-167): gốc URL của apps/mcp; token OAuth gắn với `<gốc>/mcp` và `<gốc>/team/mcp` (RFC 8707). */
  MCP_PUBLIC_URL: z.url().default("https://mcp.desklabs.xyz"),
  /** Shared secret cho introspect nội bộ apps/mcp → api. Trống = tắt introspect. Không bao giờ log. */
  MCP_INTROSPECT_SECRET: emptyToUndefined(z.string().min(32)),
  /** Desk AI (DEC-165, DEC-188): key Claude API; trống = LLM tắt, Desk AI dùng câu mẫu. Không log. */
  DESK_AI_API_KEY: z
    .string()
    .min(1)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  /** Gốc URL Telegram Bot API; chỉ đặt khi chạy E2E với Bot API giả. Trống = api.telegram.org. */
  DRIFT_TELEGRAM_API_ORIGIN: z
    .url()
    .optional()
    .or(z.literal("").transform(() => undefined)),
  /** Gốc URL Claude API; chỉ đặt khi chạy E2E với API giả. Trống = API thật của Anthropic. */
  DESK_AI_BASE_URL: z
    .url()
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
  // Claude API giả chỉ dùng cho E2E: production trỏ tới máy local thì không khởi động.
  if (
    env.NODE_ENV === "production" &&
    parsed.DESK_AI_BASE_URL !== undefined &&
    ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(parsed.DESK_AI_BASE_URL).hostname)
  ) {
    throw new Error("DESK_AI_BASE_URL must not point to localhost in production.");
  }
  if (
    env.NODE_ENV === "production" &&
    parsed.DRIFT_TELEGRAM_API_ORIGIN !== undefined &&
    ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
      new URL(parsed.DRIFT_TELEGRAM_API_ORIGIN).hostname,
    )
  ) {
    throw new Error("DRIFT_TELEGRAM_API_ORIGIN must not point to localhost in production.");
  }
  return { ...parsed, sodex: loadSodexConfig(env) };
}
