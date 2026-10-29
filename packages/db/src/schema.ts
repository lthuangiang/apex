import { ApiKeyStatus, SodexNetwork, UserRole } from "@drift/shared";
import { sql } from "drizzle-orm";
import {
  bigint,
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
    reasonCode: text("reason_code"),
    needsAttention: boolean("needs_attention").notNull().default(false),
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
    context: text("context", { enum: ["onboarding", "create", "retune"] }).notNull(),
    /** Id tất định do engine tính (cùng đầu vào → cùng id). */
    engineId: text("engine_id").notNull(),
    role: text("role", { enum: ["best", "add_on", "single"] }).notNull(),
    strategy: text("strategy").notNull(),
    market: text("market").notNull(),
    capital: numeric("capital", { precision: 38, scale: 18 }).notNull(),
    values: jsonb("values").notNull(),
    reasons: jsonb("reasons").notNull(),
    basis: text("basis").notNull(),
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
    channel: text("channel", { enum: ["in_app", "email"] }).notNull(),
    readAt: tstz("read_at"),
    ...timestamps,
  },
  (t) => [index("notifications_user_idx").on(t.userId, t.createdAt)],
);

export const notificationSettings = pgTable(
  "notification_settings",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    type: text("type").notNull(),
    channel: text("channel", { enum: ["in_app", "email"] }).notNull(),
    enabled: boolean("enabled").notNull(),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.userId, t.type, t.channel] })],
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
