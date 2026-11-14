import { ApiKeyStatus, SodexNetwork, UserRole } from "@drift/shared";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  doublePrecision,
  numeric,
  primaryKey,
  boolean,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { v7 as uuidv7 } from "uuid";

// Schema P3 (docs/DOMAIN.md mục 7.5, CODING_STANDARDS C8). Bảng của phase sau thêm bằng migration mới.

const id = () =>
  uuid("id")
    .primaryKey()
    .$defaultFn(() => uuidv7());

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

const tstz = (name: string) => timestamp(name, { withTimezone: true });

export const users = pgTable(
  "users",
  {
    id: id(),
    email: text("email").notNull(),
    walletAddress: text("wallet_address"),
    displayName: text("display_name"),
    timezone: text("timezone").notNull().default("Asia/Ho_Chi_Minh"),
    numberFormat: text("number_format").notNull().default("en-US"),
    /** Max loss mặc định cho bot mới (% vốn của bot); null = chưa đặt (Settings › Trading defaults). */
    defaultMaxLossPct: numeric("default_max_loss_pct", { precision: 10, scale: 4 }),
    /** Đã seed watchlist từ goals một lần (UI_REVIEW M2); sau đó bỏ hết market cũng không seed lại. */
    watchlistSeededAt: timestamp("watchlist_seeded_at", { withTimezone: true }),
    /** Xoá tài khoản: dữ liệu cá nhân bị xoá, dòng giữ lại cho audit (Settings › Profile). */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    /** Hash scrypt của mật khẩu (DEC-76); null = account chỉ đăng nhập bằng OTP email. */
    passwordHash: text("password_hash"),
    /** Số lần sai mật khẩu liên tiếp; đủ ngưỡng thì khoá tới `loginLockedUntil` (DEC-76). */
    failedLogins: integer("failed_logins").notNull().default(0),
    loginLockedUntil: timestamp("login_locked_until", { withTimezone: true }),
    /** Market Making và Volume Farming mở cho mọi tài khoản (DEC-94); team tắt được từng người ở Users. */
    volumeBots: boolean("volume_bots").notNull().default(true),
    /** AI Desk: team bật theo tài khoản ở Users (DEC-105). */
    aiDesk: boolean("ai_desk").notNull().default(true),
    /** AI Adaptive DCA (Beta, DEC-107): cờ riêng (DEC-192), bật cho mọi tài khoản (DEC-218); team tắt được ở Users. */
    adaptiveDca: boolean("adaptive_dca").notNull().default(true),
    twofaEnabled: boolean("twofa_enabled").notNull().default(false),
    /** Secret TOTP đã mã hoá (AES-256-GCM); null khi chưa bật. */
    twofaSecret: text("twofa_secret"),
    /** Secret đang chờ xác nhận ở bước enroll. */
    twofaPendingSecret: text("twofa_pending_secret"),
    /** Bước thời gian TOTP đã dùng gần nhất, chống dùng lại mã. */
    twofaLastStep: bigint("twofa_last_step", { mode: "number" }),
    role: text("role", { enum: [UserRole.user, UserRole.team] })
      .notNull()
      .default(UserRole.user),
    ...timestamps,
  },
  (t) => [uniqueIndex("users_email_key").on(sql`lower(${t.email})`)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    /** sha256 của token trong cookie; token gốc không lưu. */
    tokenHash: text("token_hash").notNull(),
    /** Hết hạn trượt (7 ngày kể từ lần dùng cuối, DEC-28). */
    expiresAt: tstz("expires_at").notNull(),
    /** Trần tuyệt đối 30 ngày kể từ lúc đăng nhập. */
    absoluteExpiresAt: tstz("absolute_expires_at").notNull(),
    lastSeenAt: tstz("last_seen_at").notNull().defaultNow(),
    revokedAt: tstz("revoked_at"),
    /** Lần cuối nhập đúng mã 2FA trên phiên này; trong 2 giờ sau đó không hỏi lại (DEC-115). */
    twofaVerifiedAt: tstz("twofa_verified_at"),
    ip: inet("ip"),
    userAgent: text("user_agent"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("sessions_token_hash_key").on(t.tokenHash),
    index("sessions_user_id_idx").on(t.userId),
  ],
);

export const emailOtps = pgTable(
  "email_otps",
  {
    id: id(),
    email: text("email").notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: tstz("expires_at").notNull(),
    attempts: smallint("attempts").notNull().default(0),
    consumedAt: tstz("consumed_at"),
    ...timestamps,
  },
  (t) => [index("email_otps_email_idx").on(sql`lower(${t.email})`, t.createdAt)],
);

export const twofaBackupCodes = pgTable(
  "twofa_backup_codes",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    codeHash: text("code_hash").notNull(),
    usedAt: tstz("used_at"),
    ...timestamps,
  },
  (t) => [index("twofa_backup_codes_user_id_idx").on(t.userId)],
);

export const sodexAccounts = pgTable(
  "sodex_accounts",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    address: text("address").notNull(),
    sodexAccountId: bigint("sodex_account_id", { mode: "bigint" }).notNull(),
    network: text("network", { enum: [SodexNetwork.mainnet, SodexNetwork.testnet] }).notNull(),
    status: text("status", { enum: ["connecting", "connected", "disconnected"] }).notNull(),
    ...timestamps,
  },
  (t) => [
    index("sodex_accounts_user_id_idx").on(t.userId),
    uniqueIndex("sodex_accounts_network_account_key").on(t.network, t.sodexAccountId),
  ],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: id(),
    sodexAccountId: uuid("sodex_account_id")
      .notNull()
      .references(() => sodexAccounts.id),
    name: text("name").notNull(),
    publicKey: text("public_key").notNull(),
    /** Private key đã mã hoá; chỉ `signer` giải mã được. */
    ciphertext: text("ciphertext").notNull(),
    kmsKeyRef: text("kms_key_ref").notNull(),
    last4: text("last4").notNull(),
    permissionsMask: integer("permissions_mask").notNull(),
    expiresAt: tstz("expires_at").notNull(),
    lastUsedAt: tstz("last_used_at"),
    /** `pending` = signer đã sinh key, SoDEX chưa xác nhận. */
    status: text("status", {
      enum: ["pending", ApiKeyStatus.active, ApiKeyStatus.expired, ApiKeyStatus.deleted],
    }).notNull(),
    ...timestamps,
  },
  (t) => [index("api_keys_sodex_account_id_idx").on(t.sodexAccountId)],
);

export const builderApprovals = pgTable(
  "builder_approvals",
  {
    id: id(),
    sodexAccountId: uuid("sodex_account_id")
      .notNull()
      .references(() => sodexAccounts.id),
    builderId: bigint("builder_id", { mode: "bigint" }).notNull(),
    /** null = SoDEX không trả approval nào cho DRIFT trên engine này. */
    maxFeeRateSpot: integer("max_fee_rate_spot"),
    maxFeeRatePerps: integer("max_fee_rate_perps"),
    readBackAt: tstz("read_back_at").notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex("builder_approvals_account_builder_key").on(t.sodexAccountId, t.builderId)],
);

/**
 * Mỗi chữ ký master wallet (đăng ký key, approve / revoke phí). Server dựng message, ví ký,
 * server kiểm tra chữ ký rồi gửi SoDEX và đọc lại. `unknown` = gửi rồi nhưng không rõ kết quả.
 */
export const sodexSignatureRequests = pgTable(
  "sodex_signature_requests",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    sodexAccountId: uuid("sodex_account_id")
      .notNull()
      .references(() => sodexAccounts.id),
    action: text("action", {
      enum: [
        "add_api_key",
        "approve_builder_fee",
        "revoke_builder_fee",
        "revoke_api_key_spot",
        "revoke_api_key_perps",
      ],
    }).notNull(),
    apiKeyId: uuid("api_key_id").references(() => apiKeys.id),
    /** Message EIP-712 đã dựng (uint64 dạng chuỗi). */
    message: jsonb("message").notNull(),
    status: text("status", { enum: ["pending", "succeeded", "failed", "unknown"] }).notNull(),
    sodexError: text("sodex_error"),
    expiresAt: tstz("expires_at").notNull(),
    submittedAt: tstz("submitted_at"),
    resolvedAt: tstz("resolved_at"),
    ...timestamps,
  },
  (t) => [
    index("sodex_signature_requests_user_id_idx").on(t.userId, t.createdAt),
    index("sodex_signature_requests_account_idx").on(t.sodexAccountId),
    index("sodex_signature_requests_api_key_idx").on(t.apiKeyId),
  ],
);

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: id(),
    key: uuid("key").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    requestHash: text("request_hash").notNull(),
    statusCode: smallint("status_code"),
    response: jsonb("response"),
    expiresAt: tstz("expires_at").notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("idempotency_keys_user_key").on(t.userId, t.key),
    index("idempotency_keys_expires_at_idx").on(t.expiresAt),
  ],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    userId: uuid("user_id").references(() => users.id),
    action: text("action").notNull(),
    target: text("target"),
    metadata: jsonb("metadata").notNull().default({}),
    ip: inet("ip"),
    occurredAt: tstz("occurred_at").notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [index("audit_log_user_id_idx").on(t.userId, t.occurredAt)],
);

/**
 * Từng bước của màn Connect SoDEX phía trình duyệt (DEC-114): mở trang, ví hiện ra, chọn ví, lỗi ví, chữ ký. Chỉ để
 * team hỗ trợ khách bị kẹt; không chứa chữ ký, key hay secret. `attemptId` gom các bước của một lần mở trang.
 */
export const connectEvents = pgTable(
  "connect_events",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    attemptId: uuid("attempt_id").notNull(),
    type: text("type").notNull(),
    data: jsonb("data").notNull().default({}),
    occurredAt: tstz("occurred_at").notNull().defaultNow(),
  },
  (t) => [
    index("connect_events_user_idx").on(t.userId, t.occurredAt),
    index("connect_events_time_idx").on(t.occurredAt),
  ],
);

// ---------- P4: dữ liệu ----------

const money = (name: string) => numeric(name, { precision: 38, scale: 18 });

/** Onboarding bước 3: một lần import lịch sử. `progress`/`coverage` theo từng loại dữ liệu. */
export const imports = pgTable(
  "imports",
  {
    id: id(),
    sodexAccountId: uuid("sodex_account_id")
      .notNull()
      .references(() => sodexAccounts.id),
    status: text("status", { enum: ["queued", "running", "done", "failed"] }).notNull(),
    progress: jsonb("progress").notNull().default({}),
    coverage: jsonb("coverage"),
    error: text("error"),
    startedAt: tstz("started_at"),
    finishedAt: tstz("finished_at"),
    ...timestamps,
  },
  (t) => [index("imports_account_idx").on(t.sodexAccountId, t.createdAt)],
);

/** Fill lịch sử đã import (cả lệnh ngoài DRIFT). Khác bảng `fills` của bot (P6). */
export const historyTrades = pgTable(
  "history_trades",
  {
    id: id(),
    sodexAccountId: uuid("sodex_account_id")
      .notNull()
      .references(() => sodexAccounts.id),
    engine: text("engine", { enum: ["spot", "perps"] }).notNull(),
    tradeId: bigint("trade_id", { mode: "bigint" }).notNull(),
    orderId: bigint("order_id", { mode: "bigint" }).notNull(),
    clOrdId: text("cl_ord_id").notNull(),
    market: text("market").notNull(),
    side: text("side", { enum: ["BUY", "SELL"] }).notNull(),
    price: money("price").notNull(),
    quantity: money("quantity").notNull(),
    /** Đã gồm builder fee. */
    fee: money("fee"),
    builderFee: money("builder_fee"),
    feeCoin: text("fee_coin"),
    isMaker: boolean("is_maker"),
    tradedAt: tstz("traded_at").notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("history_trades_key").on(t.sodexAccountId, t.engine, t.tradeId),
    index("history_trades_account_time_idx").on(t.sodexAccountId, t.tradedAt),
  ],
);

export const historyPositions = pgTable(
  "history_positions",
  {
    id: id(),
    sodexAccountId: uuid("sodex_account_id")
      .notNull()
      .references(() => sodexAccounts.id),
    positionId: bigint("position_id", { mode: "bigint" }).notNull(),
    market: text("market").notNull(),
    side: text("side").notNull(),
    avgEntryPrice: money("avg_entry_price").notNull(),
    avgClosePrice: money("avg_close_price").notNull(),
    closedSize: money("closed_size").notNull(),
    tradingFee: money("trading_fee").notNull(),
    realizedPnl: money("realized_pnl").notNull(),
    leverage: integer("leverage").notNull(),
    openedAt: tstz("opened_at").notNull(),
    closedAt: tstz("closed_at").notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("history_positions_key").on(t.sodexAccountId, t.positionId),
    index("history_positions_account_time_idx").on(t.sodexAccountId, t.closedAt),
  ],
);

/** `funding_payments` (DOMAIN.md) dùng cho cả lịch sử import; `bot_id` null với dữ liệu import. */
export const fundingPayments = pgTable(
  "funding_payments",
  {
    id: id(),
    sodexAccountId: uuid("sodex_account_id")
      .notNull()
      .references(() => sodexAccounts.id),
    botId: uuid("bot_id"),
    positionId: bigint("position_id", { mode: "bigint" }).notNull(),
    market: text("market").notNull(),
    /** Dương = trả, âm = nhận (theo tài liệu field `fundingFee`). */
    amount: money("amount").notNull(),
    paidAt: tstz("paid_at").notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("funding_payments_key").on(t.sodexAccountId, t.positionId, t.paidAt),
    index("funding_payments_bot_idx").on(t.botId),
  ],
);

export const accountAnalyses = pgTable(
  "account_analyses",
  {
    id: id(),
    sodexAccountId: uuid("sodex_account_id")
      .notNull()
      .references(() => sodexAccounts.id),
    importId: uuid("import_id").references(() => imports.id),
    periodStart: tstz("period_start"),
    periodEnd: tstz("period_end"),
    metrics: jsonb("metrics").notNull(),
    computedAt: tstz("computed_at").notNull(),
    ...timestamps,
  },
  (t) => [
    index("account_analyses_account_idx").on(t.sodexAccountId, t.computedAt),
    index("account_analyses_import_idx").on(t.importId),
  ],
);

/** Timescale hypertable (migration tạo hypertable). Khoá (market, ts). */
export const candles1m = pgTable(
  "candles_1m",
  {
    market: text("market").notNull(),
    ts: tstz("ts").notNull(),
    open: money("open").notNull(),
    high: money("high").notNull(),
    low: money("low").notNull(),
    close: money("close").notNull(),
    volume: money("volume").notNull(),
  },
  (t) => [primaryKey({ columns: [t.market, t.ts] })],
);

/** Funding rate theo kỳ của từng market, do `marketdata` ghi (SoDEX không có lịch sử funding thị trường). */
export const fundingRates = pgTable(
  "funding_rates",
  {
    market: text("market").notNull(),
    fundingTime: tstz("funding_time").notNull(),
    rate: numeric("rate", { precision: 38, scale: 18 }).notNull(),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.market, t.fundingTime] })],
);

export const marketStatsDaily = pgTable(
  "market_stats_daily",
  {
    market: text("market").notNull(),
    engine: text("engine", { enum: ["spot", "perps"] }).notNull(),
    date: date("date").notNull(),
    sigma30: doublePrecision("sigma30"),
    p5: money("p5"),
    p50: money("p50"),
    p95: money("p95"),
    lastPrice: money("last_price"),
    trend: doublePrecision("trend"),
    rangeScore: doublePrecision("range_score"),
    fundingAvg7d: numeric("funding_avg7d", { precision: 38, scale: 18 }),
    fundingPos21: doublePrecision("funding_pos21"),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.market, t.date] })],
);

/** Outbox (ARCHITECTURE.md mục 3.3.4): ghi cùng transaction với thay đổi trạng thái; relay publish sang NATS. */
export const outbox = pgTable(
  "outbox",
  {
    id: id(),
    topic: text("topic").notNull(),
    payload: jsonb("payload").notNull(),
    publishedAt: tstz("published_at"),
    ...timestamps,
  },
  (t) => [
    index("outbox_unpublished_idx")
      .on(t.createdAt)
      .where(sql`${t.publishedAt} is null`),
  ],
);

// ---------- P6: engine ----------

const BOT_STATES = [
  "draft",
  "starting",
  "running",
  "pausing",
  "paused",
  "resuming",
  "stopping",
  "stopped",
  "archived",
] as const;
const ORDER_STATUSES = [
  "open",
  "partially_filled",
  "filled",
  "cancelled",
  "rejected",
  "unknown",
  "not_placed",
] as const;

export const bots = pgTable(
  "bots",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    sodexAccountId: uuid("sodex_account_id")
      .notNull()
      .references(() => sodexAccounts.id),
    strategy: text("strategy").notNull(),
    market: text("market").notNull(),
    engine: text("engine", { enum: ["spot", "perps", "spot+perps"] }).notNull(),
    name: text("name").notNull(),
    state: text("state", { enum: BOT_STATES }).notNull(),
    /**
     * `paper`: lệnh chỉ mô phỏng trong DRIFT, không bao giờ lên SoDEX (DEC-105). Không đổi tại chỗ: dùng tiền thật
     * là tạo bot mới.
     */
    mode: text("mode", { enum: ["live", "paper"] })
      .notNull()
      .default("live"),
    reasonCode: text("reason_code"),
    needsAttention: boolean("needs_attention").notNull().default(false),
    /** Người dùng chọn đóng vị thế khi Stop (DEC-81); engine đọc lúc xử lý `stopping`. */
    closeOnStop: boolean("close_on_stop").notNull().default(false),
    activeVersionId: uuid("active_version_id"),
    archivedAt: tstz("archived_at"),
    ...timestamps,
  },
  (t) => [
    index("bots_user_idx").on(t.userId),
    index("bots_account_state_idx").on(t.sodexAccountId, t.state),
  ],
);

export const botVersions = pgTable(
  "bot_versions",
  {
    id: id(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id),
    version: integer("version").notNull(),
    config: jsonb("config").notNull(),
    paramSource: text("param_source", { enum: ["ai", "ai_edited", "manual"] }).notNull(),
    aiSuggestionId: uuid("ai_suggestion_id"),
    status: text("status", { enum: ["pending", "active", "superseded", "rejected"] }).notNull(),
    appliedAt: tstz("applied_at"),
    ...timestamps,
  },
  (t) => [uniqueIndex("bot_versions_bot_version_key").on(t.botId, t.version)],
);

/** State của strategy (jsonb) để engine chạy tiếp sau khi chuyển shard. Ghi kèm `epoch`. */
export const botRuntime = pgTable("bot_runtime", {
  botId: uuid("bot_id")
    .primaryKey()
    .references(() => bots.id),
  versionId: uuid("version_id").notNull(),
  state: jsonb("state").notNull(),
  epoch: bigint("epoch", { mode: "number" }).notNull(),
  ...timestamps,
});

export const orders = pgTable(
  "orders",
  {
    id: id(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id),
    sodexAccountId: uuid("sodex_account_id")
      .notNull()
      .references(() => sodexAccounts.id),
    clOrdId: text("cl_ord_id").notNull(),
    sodexOrderId: bigint("sodex_order_id", { mode: "bigint" }),
    market: text("market").notNull(),
    engine: text("engine", { enum: ["spot", "perps"] }).notNull(),
    side: text("side", { enum: ["buy", "sell"] }).notNull(),
    type: text("type", { enum: ["limit", "market"] }).notNull(),
    timeInForce: text("time_in_force").notNull(),
    price: money("price"),
    size: money("size").notNull(),
    filledSize: money("filled_size").notNull().default("0"),
    avgPrice: money("avg_price"),
    status: text("status", { enum: ORDER_STATUSES }).notNull(),
    reduceOnly: boolean("reduce_only").notNull().default(false),
    builderFee: money("builder_fee"),
    tag: text("tag").notNull(),
    epoch: bigint("epoch", { mode: "number" }).notNull(),
    submittedAt: tstz("submitted_at"),
    ackedAt: tstz("acked_at"),
    reconciledAt: tstz("reconciled_at"),
    rejectCode: text("reject_code"),
    rejectMessage: text("reject_message"),
    /**
     * Lúc engine đã báo chiến lược lệnh này kết thúc (`orderDone` / `orderReject`); chỉ báo một lần dù user stream và
     * đối soát cùng thấy (P0.1, rà soát strategy 2026-11-14).
     */
    doneFedAt: tstz("done_fed_at"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("orders_account_cl_ord_key").on(t.sodexAccountId, t.clOrdId),
    index("orders_bot_idx").on(t.botId, t.createdAt),
    index("orders_status_idx").on(t.status),
  ],
);

export const fills = pgTable(
  "fills",
  {
    id: id(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    sodexTradeId: bigint("sodex_trade_id", { mode: "bigint" }).notNull(),
    price: money("price").notNull(),
    size: money("size").notNull(),
    /** Đã gồm builder fee. */
    fee: money("fee").notNull(),
    builderFee: money("builder_fee"),
    feeCoin: text("fee_coin"),
    isMaker: boolean("is_maker"),
    filledAt: tstz("filled_at").notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("fills_trade_key").on(t.sodexTradeId),
    index("fills_order_idx").on(t.orderId),
  ],
);

export const botEvents = pgTable(
  "bot_events",
  {
    id: id(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id),
    type: text("type").notNull(),
    decision: text("decision"),
    why: text("why"),
    result: text("result"),
    payload: jsonb("payload").notNull().default({}),
    occurredAt: tstz("occurred_at").notNull(),
    ...timestamps,
  },
  (t) => [index("bot_events_bot_idx").on(t.botId, t.occurredAt)],
);

/**
 * Review sau khi chạy của bot Volume Builder (DEC-131): chạy lại lối thoát trên lệnh vào thật với nhiều bộ tham số.
 * Worker `backtest` tính (cùng hàng đợi `backtest.run`, payload `{ reviewId }`); `result` theo `botReviewResultSchema`.
 */
export const botReviews = pgTable(
  "bot_reviews",
  {
    id: id(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    status: text("status", {
      enum: ["queued", "running", "done", "failed", "unavailable"],
    }).notNull(),
    result: jsonb("result"),
    error: text("error"),
    /** Version đã tạo từ đề xuất này (nút Use these settings), null nếu chưa áp dụng. */
    appliedVersion: integer("applied_version"),
    finishedAt: tstz("finished_at"),
    ...timestamps,
  },
  (t) => [index("bot_reviews_bot_idx").on(t.botId, t.createdAt)],
);

/**
 * Builder fee riêng theo user × chiến lược do team đặt (DEC-159), phần mười bp, 0–`DRIFT_BUILDER_FEE_RATE`.
 * Không có dòng = mặc định của chiến lược (`builderFeeRateOf`).
 */
export const userBuilderFees = pgTable(
  "user_builder_fees",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    strategy: text("strategy").notNull(),
    rate: integer("rate").notNull(),
    /** Thành viên team đặt mức này. */
    updatedBy: uuid("updated_by")
      .notNull()
      .references(() => users.id),
    ...timestamps,
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.strategy] }),
    check("user_builder_fees_rate_range", sql`${t.rate} >= 0 and ${t.rate} <= 10`),
  ],
);

export const shardEpochs = pgTable("shard_epochs", {
  shard: integer("shard").primaryKey(),
  epoch: bigint("epoch", { mode: "number" }).notNull(),
  owner: text("owner").notNull(),
  acquiredAt: tstz("acquired_at").notNull(),
});

/** Mục tiêu ở onboarding bước 5 (DOMAIN.md mục 7.5). Một dòng mỗi user; lưu lại thì ghi đè. */
export const goals = pgTable("goals", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id),
  goal: text("goal", { enum: ["automate", "range", "accumulate", "steady"] }).notNull(),
  capital: numeric("capital", { precision: 38, scale: 18 }).notNull(),
  /** "5" | "10" | "20" | "unsure" (unsure tính như 5). */
  maxDrop: text("max_drop", { enum: ["5", "10", "20", "unsure"] }).notNull(),
  markets: text("markets").array().notNull(),
  ...timestamps,
});

/** Watchlist của Overview (UI_REVIEW M2, DEC-74): tối đa 8 market, thứ tự theo `position`. */
export const watchlistItems = pgTable(
  "watchlist_items",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    market: text("market").notNull(),
    engine: text("engine", { enum: ["spot", "perps"] }).notNull(),
    position: smallint("position").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.market] })],
);

/** Kết quả engine đề xuất (RECO_ENGINE.md mục 10.6). `bot_versions.ai_suggestion_id` trỏ tới đây. */
export const aiSuggestions = pgTable(
  "ai_suggestions",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    context: text("context", { enum: ["onboarding", "create", "retune", "desk"] }).notNull(),
    /** Id tất định do engine tính (cùng đầu vào → cùng id). */
    engineId: text("engine_id").notNull(),
    role: text("role", { enum: ["best", "add_on", "single"] }).notNull(),
    strategy: text("strategy").notNull(),
    market: text("market").notNull(),
    capital: numeric("capital", { precision: 38, scale: 18 }).notNull(),
    values: jsonb("values").notNull(),
    reasons: jsonb("reasons").notNull(),
    basis: text("basis").notNull(),
    /** Chiến lược không được chọn và lý do, lưu cùng lần đề xuất (AI Desk › Why this one). */
    notSuggested: jsonb("not_suggested"),
    /** Mức chịu lỗ (%) của lần đề xuất, để trang Why this one hiện đúng câu trả lời. */
    maxDrop: text("max_drop"),
    inputsVersion: text("inputs_version").notNull(),
    computedAt: tstz("computed_at").notNull(),
    ...timestamps,
  },
  (t) => [index("ai_suggestions_user_idx").on(t.userId, t.computedAt)],
);

/** Kết quả backtest (BACKTEST.md mục 11). Cache theo (strategy, market, params_hash, period_days, data_version). */
export const backtestRuns = pgTable(
  "backtest_runs",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    strategy: text("strategy").notNull(),
    market: text("market").notNull(),
    /** sha256 của config dạng JSON có khoá sắp xếp. */
    paramsHash: text("params_hash").notNull(),
    config: jsonb("config").notNull(),
    periodDays: integer("period_days").notNull(),
    /** `<interval>:<ngày kết thúc UTC>`; dữ liệu quá khứ không đổi nên cache theo ngày. */
    dataVersion: text("data_version").notNull(),
    status: text("status", {
      enum: ["queued", "running", "done", "failed", "unavailable"],
    }).notNull(),
    result: jsonb("result"),
    error: text("error"),
    finishedAt: tstz("finished_at"),
    ...timestamps,
  },
  (t) => [
    index("backtest_runs_cache_idx").on(
      t.strategy,
      t.market,
      t.paramsHash,
      t.periodDays,
      t.dataVersion,
    ),
    index("backtest_runs_user_idx").on(t.userId, t.createdAt),
  ],
);

/** Equity theo thời gian của account (scheduler ghi mỗi phút): đường equity Overview, daily loss, drawdown. */
export const equitySnapshots = pgTable(
  "equity_snapshots",
  {
    sodexAccountId: uuid("sodex_account_id")
      .notNull()
      .references(() => sodexAccounts.id),
    at: tstz("at").notNull(),
    equity: money("equity").notNull(),
  },
  (t) => [primaryKey({ columns: [t.sodexAccountId, t.at] })],
);

/** Giới hạn rủi ro (DOMAIN.md mục 7.5). `null` = chưa đặt. `enforced` ghi rõ giới hạn nào server chặn. */
export const riskLimits = pgTable("risk_limits", {
  sodexAccountId: uuid("sodex_account_id")
    .primaryKey()
    .references(() => sodexAccounts.id),
  dailyLossPct: numeric("daily_loss_pct", { precision: 10, scale: 4 }),
  maxDrawdownPct: numeric("max_drawdown_pct", { precision: 10, scale: 4 }),
  perTradePct: numeric("per_trade_pct", { precision: 10, scale: 4 }),
  maxLeverage: numeric("max_leverage", { precision: 10, scale: 4 }),
  maxPositions: integer("max_positions"),
  enforced: jsonb("enforced").notNull(),
  ...timestamps,
});

/** Cảnh báo của risk engine (màn Risk Center › Alerts). */
export const riskAlerts = pgTable(
  "risk_alerts",
  {
    id: id(),
    sodexAccountId: uuid("sodex_account_id")
      .notNull()
      .references(() => sodexAccounts.id),
    kind: text("kind").notNull(),
    severity: text("severity", { enum: ["notice", "warning", "critical"] }).notNull(),
    /** Số liệu đi kèm (ví dụ % đã lỗ, giới hạn), để UI dựng câu. */
    data: jsonb("data").notNull(),
    occurredAt: tstz("occurred_at").notNull(),
    acknowledgedAt: tstz("acknowledged_at"),
    resolvedAt: tstz("resolved_at"),
    ...timestamps,
  },
  (t) => [index("risk_alerts_account_idx").on(t.sodexAccountId, t.occurredAt)],
);

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    channel: text("channel", { enum: ["in_app", "email", "telegram"] }).notNull(),
    readAt: tstz("read_at"),
    /** Chỉ cho bản `telegram` (docs/NOTIFICATIONS.md mục 8); null với in-app và email. */
    deliveryStatus: text("delivery_status", { enum: ["queued", "sent", "failed"] }),
    /**
     * Khoá chống trùng (DEC-212): tin về lệnh tiền thật (ví dụ `copy_bot_opened:<botId>:<clOrdID>`)
     * chỉ ghi một lần cho mỗi user × kênh, kể cả khi outbox / NATS giao lại. Null = không chống trùng.
     */
    dedupeKey: text("dedupe_key"),
    ...timestamps,
  },
  (t) => [
    index("notifications_user_idx").on(t.userId, t.createdAt),
    uniqueIndex("notifications_dedupe_key")
      .on(t.userId, t.channel, t.dedupeKey)
      .where(sql`${t.dedupeKey} is not null`),
  ],
);

export const notificationSettings = pgTable(
  "notification_settings",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    type: text("type").notNull(),
    channel: text("channel", { enum: ["in_app", "email", "telegram"] }).notNull(),
    enabled: boolean("enabled").notNull(),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.userId, t.type, t.channel] })],
);

/**
 * Token kết nối Telegram (docs/NOTIFICATIONS.md mục 3, DEC-170): chỉ lưu SHA-256, sống 10 phút, dùng 1 lần,
 * mỗi user tối đa 1 token còn hiệu lực (tạo mới thì xoá token cũ).
 */
export const telegramLinkTokens = pgTable(
  "telegram_link_tokens",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    tokenHash: text("token_hash").notNull(),
    expiresAt: tstz("expires_at").notNull(),
    usedAt: tstz("used_at"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("telegram_link_tokens_token_hash_key").on(t.tokenHash),
    index("telegram_link_tokens_user_idx").on(t.userId),
  ],
);

/** Chat Telegram đã kết nối: 1 user ↔ 1 chat; một `chat_id` chỉ gắn với 1 user (mục 3 "Quy tắc"). */
export const telegramLinks = pgTable(
  "telegram_links",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id),
    // Telegram: chat id vừa trong 52 bit, nên `number` không mất chính xác.
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    username: text("username"),
    status: text("status", { enum: ["active", "blocked"] }).notNull(),
    connectedAt: tstz("connected_at").notNull(),
    lastSentAt: tstz("last_sent_at"),
    blockedAt: tstz("blocked_at"),
  },
  (t) => [uniqueIndex("telegram_links_chat_id_key").on(t.chatId)],
);

/** Số dư tài khoản builder của DRIFT theo ngày và engine (đối soát builder revenue). */
export const builderBalanceSnapshots = pgTable(
  "builder_balance_snapshots",
  {
    date: date("date").notNull(),
    engine: text("engine", { enum: ["spot", "perps"] }).notNull(),
    balance: money("balance").notNull(),
    takenAt: tstz("taken_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.date, t.engine] })],
);

/** Đối soát builder revenue (SODEX.md mục 5.4): phần chênh không giải thích được để pending. */
export const builderRevenueDaily = pgTable(
  "builder_revenue_daily",
  {
    date: date("date").notNull(),
    engine: text("engine", { enum: ["spot", "perps"] }).notNull(),
    fromFills: money("from_fills").notNull(),
    fills: integer("fills").notNull(),
    notional: money("notional").notNull(),
    balanceDelta: money("balance_delta"),
    difference: money("difference"),
    status: text("status", { enum: ["matched", "pending"] }).notNull(),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.date, t.engine] })],
);

/**
 * Số dư giả của bot paper (DEC-105). Không liên quan ví SoDEX. `positions`: theo market, `qty` có dấu (perps âm là
 * short, spot là lượng coin giữ), `avgCost` giá vốn. Mọi số là decimal string.
 */
export const paperAccounts = pgTable("paper_accounts", {
  botId: uuid("bot_id")
    .primaryKey()
    .references(() => bots.id),
  capital: money("capital").notNull(),
  cash: money("cash").notNull(),
  positions: jsonb("positions").notNull(),
  fees: money("fees").notNull().default("0"),
  funding: money("funding").notNull().default("0"),
  fills: integer("fills").notNull().default(0),
  peakEquity: money("peak_equity").notNull(),
  maxDrawdown: money("max_drawdown").notNull().default("0"),
  /** Giá đầu của tài sản chính lúc bắt đầu, để so với chỉ giữ coin. */
  startPrice: money("start_price"),
  startedAt: tstz("started_at").notNull(),
  ...timestamps,
});

/** Lần khớp mô phỏng của bot paper. Bảng riêng: không bao giờ lẫn vào `fills` (volume, builder revenue, phí). */
export const paperFills = pgTable(
  "paper_fills",
  {
    id: id(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    market: text("market").notNull(),
    side: text("side", { enum: ["buy", "sell"] }).notNull(),
    price: money("price").notNull(),
    size: money("size").notNull(),
    fee: money("fee").notNull(),
    isMaker: boolean("is_maker").notNull(),
    filledAt: tstz("filled_at").notNull(),
    ...timestamps,
  },
  (t) => [index("paper_fills_bot_idx").on(t.botId, t.filledAt)],
);

/** Số dư giả theo phút (biểu đồ "Simulated balance by day" gom theo ngày). */
export const paperSnapshots = pgTable(
  "paper_snapshots",
  {
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id),
    at: tstz("at").notNull(),
    equity: money("equity").notNull(),
  },
  (t) => [uniqueIndex("paper_snapshots_key").on(t.botId, t.at)],
);

/*
 * Copy Trading v1 (DEC-163, docs/COPY_TRADING_DATA.md). Ví leader chỉ đọc (Hyperliquid), không có key, không ký.
 */

/** Ví ứng viên từ leaderboard Hyperliquid. `isVault` null = chưa hỏi `userRole` (weight 60, hỏi một lần). */
export const leaderWallets = pgTable(
  "leader_wallets",
  {
    source: text("source", { enum: ["sodex", "hyperliquid"] }).notNull(),
    address: text("address").notNull(),
    displayName: text("display_name"),
    isVault: boolean("is_vault"),
    /** Giá trị tài khoản và PnL 30 ngày theo leaderboard lần thấy gần nhất (chỉ để chọn ứng viên). */
    accountValue: money("account_value"),
    leaderboardPnl30d: money("leaderboard_pnl_30d"),
    lastOnLeaderboardAt: tstz("last_on_leaderboard_at"),
    /** Fill mới nhất đã đọc (ms UTC) cho T0 / T1, để lần poll sau chỉ đọc phần mới. */
    fillCursor: bigint("fill_cursor", { mode: "number" }),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.source, t.address] })],
);

/** Một lần tính lại leaderboard (T2). Danh sách hiển thị dùng lần `ok` gần nhất; lỗi thì giữ lần trước. */
export const leaderboardRuns = pgTable("leaderboard_runs", {
  date: date("date").primaryKey(),
  status: text("status", { enum: ["running", "ok", "failed"] }).notNull(),
  candidates: integer("candidates"),
  computed: integer("computed"),
  error: text("error"),
  finishedAt: tstz("finished_at"),
  ...timestamps,
});

/** Thống kê 30 ngày của một ví theo ngày tính (`LeaderStats` trong `@drift/shared`). */
export const leaderStatsDaily = pgTable(
  "leader_stats_daily",
  {
    source: text("source", { enum: ["sodex", "hyperliquid"] }).notNull(),
    address: text("address").notNull(),
    date: date("date").notNull(),
    /** `LeaderStats` đầy đủ. */
    stats: jsonb("stats").notNull(),
    hidden: text("hidden").array().notNull(),
    tabs: text("tabs").array().notNull(),
    steadyScore: doublePrecision("steady_score"),
    profit: money("profit").notNull(),
    typicalHoldMs: bigint("typical_hold_ms", { mode: "number" }),
    computedAt: tstz("computed_at").notNull(),
    ...timestamps,
  },
  (t) => [
    primaryKey({ columns: [t.source, t.address, t.date] }),
    index("leader_stats_daily_date_idx").on(t.date),
  ],
);

/** Thay đổi vị thế của ví leader: fill cùng (ví, coin) trong 60 giây gộp thành một sự kiện (DEC-163 mục 11). */
export const leaderEvents = pgTable(
  "leader_events",
  {
    id: id(),
    source: text("source", { enum: ["sodex", "hyperliquid"] }).notNull(),
    address: text("address").notNull(),
    coin: text("coin").notNull(),
    /** Market SoDEX tương ứng; null = SoDEX không có ("Not listed"). */
    market: text("market"),
    kind: text("kind", {
      enum: ["open", "add", "reduce", "close", "flip", "liquidated"],
    }).notNull(),
    /** Vị thế có dấu trước và sau sự kiện (đơn vị coin). */
    positionBefore: money("position_before").notNull(),
    positionAfter: money("position_after").notNull(),
    /** Notional thay đổi (USD, luôn dương) và giá trung bình của các fill trong sự kiện. */
    notional: money("notional").notNull(),
    price: money("price").notNull(),
    /** PnL đã chốt trừ phí (USD) khi sự kiện đóng một phần / toàn bộ; null với mở / tăng. */
    realized: money("realized"),
    /** Thời điểm fill đầu tiên của sự kiện và lúc DeskLabs thấy nó (độ trễ thật). */
    at: tstz("at").notNull(),
    seenAt: tstz("seen_at").notNull(),
    /** tid fill cuối, để không ghi trùng khi poll lại. */
    lastTid: text("last_tid").notNull(),
    ...timestamps,
  },
  (t) => [
    index("leader_events_addr_at_idx").on(t.source, t.address, t.at),
    uniqueIndex("leader_events_dedupe").on(t.source, t.address, t.lastTid),
  ],
);

/** Ví người dùng theo dõi (Following, tối đa 5 / người, DEC-163 mục 10). */
export const leaderFollows = pgTable(
  "leader_follows",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    source: text("source", { enum: ["sodex", "hyperliquid"] }).notNull(),
    address: text("address").notNull(),
    /**
     * Mức cảnh báo cho trader này (DEC-209): `big_moves` (mặc định) / `positions` (mở mới, đóng hẳn,
     * đảo chiều, cộng big move) / `off`.
     */
    alertLevel: text("alert_level", { enum: ["big_moves", "positions", "off"] })
      .notNull()
      .default("big_moves"),
    ...timestamps,
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.source, t.address] }),
    index("leader_follows_wallet_idx").on(t.source, t.address),
  ],
);

/**
 * Lần cảnh báo vị thế (mở mới / đóng hẳn / đảo chiều) gần nhất theo (ví, coin): cách nhau ≥ 10 phút
 * (DEC-209). Tách khỏi `leader_alert_state` của big move.
 */
export const leaderPositionAlertState = pgTable(
  "leader_position_alert_state",
  {
    source: text("source", { enum: ["sodex", "hyperliquid"] }).notNull(),
    address: text("address").notNull(),
    coin: text("coin").notNull(),
    lastAlertAt: tstz("last_alert_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.source, t.address, t.coin] })],
);

/** Lần cảnh báo "big move" gần nhất theo (ví, coin): cách nhau ≥ 10 phút (DEC-163 mục 11). */
export const leaderAlertState = pgTable(
  "leader_alert_state",
  {
    source: text("source", { enum: ["sodex", "hyperliquid"] }).notNull(),
    address: text("address").notNull(),
    coin: text("coin").notNull(),
    lastAlertAt: tstz("last_alert_at").notNull(),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.source, t.address, t.coin] })],
);

/**
 * Việc "Needs you" của AI Desk B+ (DEC-164, DEC-166): mỗi bot × quy tắc một dòng, cập nhật mỗi lần tính. `snoozedAt`:
 * user bấm "Later" / "Not now" (ẩn 7 ngày trừ khi dữ liệu xấu đi); `resolvedAt`: quy tắc không còn đúng.
 */
export const deskItems = pgTable(
  "desk_items",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id),
    rule: text("rule", {
      enum: ["liquidation_before_stop", "max_loss_hit", "taker_costly", "better_review"],
    }).notNull(),
    severity: integer("severity").notNull(),
    /** `DeskFact[]` lúc tính gần nhất (nguồn số liệu cho thẻ và cho Desk AI). */
    facts: jsonb("facts").notNull(),
    fingerprint: text("fingerprint").notNull(),
    badness: money("badness").notNull(),
    snoozedAt: tstz("snoozed_at"),
    resolvedAt: tstz("resolved_at"),
    lastSeenAt: tstz("last_seen_at").notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("desk_items_bot_rule").on(t.botId, t.rule),
    index("desk_items_user_idx").on(t.userId),
  ],
);

/**
 * So sánh phương án của một việc "Needs you" (AI Desk B+ M2, DEC-166): worker `backtest` replay lệnh vào thật (Volume
 * Builder) hoặc backtest nến 7 ngày (chiến lược khác) cho từng phương án. `options` là phương án + kết quả.
 */
export const deskWhatifs = pgTable(
  "desk_whatifs",
  {
    id: id(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => deskItems.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id),
    /** Version của bot lúc tính (Apply chỉ khi bot vẫn ở version này). */
    botVersion: integer("bot_version").notNull(),
    /** Fingerprint của việc lúc tính: việc đổi (dữ liệu mới) thì tính lại. */
    itemFingerprint: text("item_fingerprint").notNull(),
    status: text("status", {
      enum: ["queued", "running", "done", "failed", "unavailable"],
    }).notNull(),
    /** `replay` (lệnh vào thật) hoặc `backtest` (nến); null khi chưa chạy. */
    source: text("source", { enum: ["replay", "backtest"] }),
    /** `WhatIfOptionResult[]` (patch config + kết quả 7 ngày). */
    options: jsonb("options").notNull(),
    windowFrom: tstz("window_from").notNull(),
    windowTo: tstz("window_to").notNull(),
    error: text("error"),
    finishedAt: tstz("finished_at"),
    ...timestamps,
  },
  (t) => [index("desk_whatifs_item_idx").on(t.itemId, t.createdAt)],
);

/**
 * Lần Apply một phương án (version mới "AI suggested", DEC-166): nguồn cho thành tích sau 7 ngày (M4) và Switch back.
 * `baselineConfig` là config trước khi áp.
 */
export const deskApplies = pgTable(
  "desk_applies",
  {
    id: id(),
    whatifId: uuid("whatif_id")
      .notNull()
      .references(() => deskWhatifs.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id),
    rule: text("rule").notNull(),
    option: text("option").notNull(),
    fromVersion: integer("from_version").notNull(),
    // null trong lúc đang tạo version mới: dòng này giữ chỗ để mỗi so sánh chỉ Apply một lần.
    toVersion: integer("to_version"),
    baselineConfig: jsonb("baseline_config").notNull(),
    appliedAt: tstz("applied_at").notNull(),
    // Thành tích (M4): đo 7 ngày sau Apply. measuring → queued (scheduler xếp job) → done / unavailable.
    recordStatus: text("record_status")
      .$type<"measuring" | "queued" | "done" | "unavailable">()
      .notNull()
      .default("measuring"),
    /** Kết quả đo: nguồn, lãi / lỗ sau khi sửa, của cấu hình cũ trên cùng các ngày, số lượt, cửa sổ. */
    record: jsonb("record"),
    verdict: text("verdict").$type<"helped" | "made_worse" | "no_clear_effect">(),
    recordError: text("record_error"),
    checkedAt: tstz("checked_at"),
    /** Version tạo bởi Switch back (cấu hình cũ); null khi chưa quay lại, −1 trong lúc đang tạo. */
    switchedBackVersion: integer("switched_back_version"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("desk_applies_whatif").on(t.whatifId),
    index("desk_applies_bot_idx").on(t.botId, t.appliedAt),
    index("desk_applies_record_idx").on(t.recordStatus, t.appliedAt),
  ],
);

/**
 * Desk AI (AI Desk B+ M5, DEC-165): cuộc trò chuyện của user. `brief` = báo cáo sáng, mỗi ngày địa phương một lần.
 * Lưu 90 ngày rồi tự xoá (scheduler); user xoá được bằng "Delete history".
 */
export const deskAiConversations = pgTable(
  "desk_ai_conversations",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    kind: text("kind").$type<"chat" | "brief">().notNull(),
    /** Câu hỏi đầu tiên (chat) hoặc rỗng (brief: web dịch tiêu đề). */
    title: text("title").notNull(),
    /** Ngày địa phương `YYYY-MM-DD` theo `users.timezone` lúc tạo. */
    localDate: text("local_date").notNull(),
    ...timestamps,
  },
  (t) => [
    index("desk_ai_conversations_user_idx").on(t.userId, t.createdAt),
    uniqueIndex("desk_ai_conversations_brief")
      .on(t.userId, t.localDate)
      .where(sql`kind = 'brief'`),
  ],
);

/**
 * Mỗi lượt Desk AI: câu hỏi, câu trả lời (lời LLM hoặc câu mẫu), và nhật ký (mục 5.10): model, phiên bản prompt, id
 * fact đầu vào, token, chi phí ước tính, traceId. Không lưu key hay payload API.
 */
export const deskAiTurns = pgTable(
  "desk_ai_turns",
  {
    id: id(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => deskAiConversations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    kind: text("kind").$type<"question" | "brief">().notNull(),
    localDate: text("local_date").notNull(),
    question: text("question"),
    /** `DeskAiAnswer` (packages/shared/src/api/desk.ts). */
    answer: jsonb("answer").notNull(),
    /** `llm` khi lời LLM qua kiểm tra số; `template` khi dùng câu mẫu. */
    source: text("source").$type<"llm" | "template">().notNull(),
    /** Vì sao dùng câu mẫu: llm_off, quota, out_of_scope, numbers, truncated, refusal, error. */
    fallback: text("fallback"),
    model: text("model"),
    promptVersion: text("prompt_version").notNull(),
    factIds: text("fact_ids").array().notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 18, scale: 8 }),
    traceId: text("trace_id"),
    ...timestamps,
  },
  (t) => [
    index("desk_ai_turns_conversation_idx").on(t.conversationId, t.createdAt),
    index("desk_ai_turns_quota_idx").on(t.userId, t.localDate),
  ],
);

/**
 * Desk AI: số câu hỏi đã dùng mỗi ngày địa phương (DEC-165b, 20 câu / ngày). Tách khỏi lịch sử chat để "Delete history"
 * không đặt lại lượt; giữ chỗ bằng một câu `insert … on conflict do update … where questions < 20` nên hai request song
 * song ở câu thứ 20 không cùng qua.
 */
export const deskAiUsage = pgTable(
  "desk_ai_usage",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    localDate: text("local_date").notNull(),
    questions: integer("questions").notNull().default(0),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.userId, t.localDate] })],
);

/* ---------------------------------- MCP + OAuth (docs/MCP.md, DEC-167) ---------------------------------- */

/**
 * Client OAuth của MCP. `id` là `client_id`: chuỗi ngẫu nhiên khi đăng ký động (RFC 7591, `kind = dcr`) hoặc chính URL
 * https của Client ID Metadata Document (`kind = cimd`, metadata tải về và cache). `name` là dữ liệu client tự khai,
 * không tin cậy: màn consent luôn hiện kèm host. Client đăng ký động không dùng 30 ngày thì xoá.
 */
export const oauthClients = pgTable(
  "oauth_clients",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["dcr", "cimd"] }).notNull(),
    name: text("name"),
    redirectUris: text("redirect_uris").array().notNull(),
    /** CIMD: lần tải metadata gần nhất (cache 1 giờ). */
    fetchedAt: tstz("fetched_at"),
    lastUsedAt: tstz("last_used_at"),
    ...timestamps,
  },
  (t) => [index("oauth_clients_last_used_idx").on(t.lastUsedAt)],
);

/** Authorization code (một lần, sống vài phút). Chỉ lưu hash. PKCE S256 bắt buộc; gắn với `resource` (RFC 8707). */
export const oauthCodes = pgTable("oauth_codes", {
  codeHash: text("code_hash").primaryKey(),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthClients.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  redirectUri: text("redirect_uri").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  scope: text("scope").array().notNull(),
  resource: text("resource").notNull(),
  expiresAt: tstz("expires_at").notNull(),
  usedAt: tstz("used_at"),
  ...timestamps,
});

/**
 * Token MCP (access 1 giờ, refresh 30 ngày), chỉ lưu hash. Refresh xoay mỗi lần dùng: dòng cũ ghi `rotated_at`, dòng
 * mới cùng `family_id`. Refresh đã xoay mà bị dùng lại → thu hồi cả họ. Revoke có hiệu lực ngay (kiểm tra mỗi request).
 */
export const mcpTokens = pgTable(
  "mcp_tokens",
  {
    id: id(),
    familyId: uuid("family_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.id, { onDelete: "cascade" }),
    scope: text("scope").array().notNull(),
    resource: text("resource").notNull(),
    accessHash: text("access_hash").notNull(),
    accessExpiresAt: tstz("access_expires_at").notNull(),
    refreshHash: text("refresh_hash").notNull(),
    refreshExpiresAt: tstz("refresh_expires_at").notNull(),
    rotatedAt: tstz("rotated_at"),
    revokedAt: tstz("revoked_at"),
    lastUsedAt: tstz("last_used_at"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("mcp_tokens_access_hash_key").on(t.accessHash),
    uniqueIndex("mcp_tokens_refresh_hash_key").on(t.refreshHash),
    index("mcp_tokens_user_client_idx").on(t.userId, t.clientId),
    index("mcp_tokens_family_idx").on(t.familyId),
  ],
);

/** Nhật ký mỗi lần gọi tool MCP (giữ 90 ngày). Không lưu tham số gốc hay nội dung trả về, chỉ hash tham số. */
export const mcpCalls = pgTable(
  "mcp_calls",
  {
    id: id(),
    tokenId: uuid("token_id"),
    userId: uuid("user_id"),
    clientId: text("client_id"),
    endpoint: text("endpoint", { enum: ["user", "team"] }).notNull(),
    tool: text("tool").notNull(),
    argsHash: text("args_hash"),
    durationMs: integer("duration_ms"),
    status: text("status", { enum: ["ok", "error", "denied", "rate_limited"] }).notNull(),
    traceId: text("trace_id"),
    ...timestamps,
  },
  (t) => [
    index("mcp_calls_created_idx").on(t.createdAt),
    index("mcp_calls_user_idx").on(t.userId, t.createdAt),
  ],
);

/**
 * Bản nháp do Claude tạo qua MCP (scope `draft`, DEC-167, DEC-223). Không ảnh hưởng bot nào: người dùng mở
 * link, xem lại trên màn Create / Edit có sẵn rồi tự Save / Apply / Start. `bot_id` null = bot mới. Hết hạn sau 24 giờ;
 * `opened_at` ghi lần đầu người dùng mở (bản đã mở không tính vào giới hạn 20 bản đang chờ).
 */
export const botDrafts = pgTable(
  "bot_drafts",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    botId: uuid("bot_id").references(() => bots.id),
    strategy: text("strategy").notNull(),
    name: text("name"),
    config: jsonb("config").notNull(),
    source: text("source", { enum: ["mcp"] })
      .notNull()
      .default("mcp"),
    clientId: text("client_id"),
    expiresAt: tstz("expires_at").notNull(),
    openedAt: tstz("opened_at"),
    ...timestamps,
  },
  (t) => [index("bot_drafts_user_idx").on(t.userId, t.expiresAt)],
);

/**
 * Chi phí làm market theo giờ (D1, DEC-227), marketdata ghi từ WS `trade` + `bookTicker` của SoDEX cho tối đa 30
 * market volume cao nhất + market có bot MM. `markoutNotional` = Σ notional × markout 30 s (bps, phía maker). Giờ chưa có
 * dữ liệu thì không có dòng (không bao giờ ghi 0). Giữ 48 giờ.
 */
export const mmMarketHourly = pgTable(
  "mm_market_hourly",
  {
    market: text("market").notNull(),
    hour: tstz("hour").notNull(),
    notional: money("notional").notNull(),
    markoutNotional: money("markout_notional").notNull(),
    trades: integer("trades").notNull(),
    /** Số mẫu spread (mỗi giây) theo số tick: `{ "1": 3400, "2": 120 }`. */
    spreadTicks: jsonb("spread_ticks").notNull(),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.market, t.hour] })],
);

/** Giá giữa mỗi giây (D2 markout 5 / 30 / 60 s), chỉ market đang có bot MM; giữ 48 giờ (DEC-227). */
export const mid1s = pgTable(
  "mid_1s",
  {
    market: text("market").notNull(),
    ts: tstz("ts").notNull(),
    mid: money("mid").notNull(),
  },
  (t) => [primaryKey({ columns: [t.market, t.ts] })],
);

/**
 * Hệ số mô hình chi phí Market Making (DEC-228): PnL giá = a × bước − k × dao động, fit mỗi ngày từ bot thật.
 * Mỗi lần fit một dòng (version tăng dần); API dùng dòng mới nhất, chưa có dòng nào thì dùng hệ số khởi đầu (version 0).
 */
export const mmModelCoefs = pgTable("mm_model_coefs", {
  version: integer("version").primaryKey().generatedAlwaysAsIdentity(),
  a: numeric("a", { precision: 20, scale: 10 }).notNull(),
  k: numeric("k", { precision: 20, scale: 10 }).notNull(),
  /** Số điểm (bot, market, ngày) đã dùng. */
  points: integer("points").notNull(),
  /** Ngày dữ liệu (UTC) của lần fit. */
  day: date("day").notNull(),
  createdAt: tstz("created_at").notNull().defaultNow(),
});
