import {
  apiKeys,
  botEvents,
  botRuntime,
  bots,
  botVersions,
  copiedLeaders,
  fills,
  latestTypicalHold,
  orders,
  outbox,
  riskAlerts,
  riskLimits,
  sodexAccounts,
  users,
  type Db,
} from "@drift/db";
import {
  AppError,
  applyCommand,
  BotCommand,
  BotState,
  CheckKey,
  dec,
  Decimal,
  ErrorCode,
  isBuilderAccount,
  meetsMinHold,
  leverageConflict,
  leverageSpecsOf,
  ReasonCode,
  startOfDay,
  Strategy,
  VOLUME_STRATEGIES,
  EXPERIMENTAL_STRATEGIES,
  type BotDetail,
  BOT_FILLS_PAGE_SIZE,
  type BotFillList,
  type BotSummary,
  type CreateBotBody,
  type OrderView,
  type StartChecks,
} from "@drift/shared";
import { readDriftApproval, type SodexRestClient } from "@drift/sodex";
import {
  type AdaptiveDcaState,
  copyLedgerTotals,
  copyMarkets,
  costPerMillion,
  costUsed,
  farmNet,
  isMultiMarketCopyState,
  netPnl,
  type Ledger,
  leverageCapIssue,
  meetsMinSize,
  minSizeDetail,
  requirementOf,
  botCapitalOf,
  STRATEGIES,
  waitingOf,
  volumeFarm,
  type MarketRules,
  type VolumeFarmState,
  type VolumeMakerState,
} from "@drift/strategies";
import { and, desc, eq, gte, inArray, isNull, max, sql } from "drizzle-orm";
import { getAddress } from "viem";

import { AuditAction, audit } from "../../lib/audit";
import { iso } from "../security/service";
import { verifyTwoFactor, type TwoFactorDeps } from "../security/two-factor";

// Bot CRUD và hành động trạng thái (SCREENS.md mục 8.2–8.4, DOMAIN.md mục 7). API chỉ đưa bot vào
// trạng thái chuyển tiếp; engine xác nhận trạng thái cuối (quy tắc 1.6).

/** Giá cũ hơn mức này thì kiểm tra "Giá được cập nhật trong vòng ≤ 5 s" không đạt. */
export const PRICE_FRESH_MS = 5_000;

export interface BotDeps extends TwoFactorDeps {
  rest: Pick<
    SodexRestClient,
    | "getBuilderApprovals"
    | "getSpotBalances"
    | "getPerpsAccountValue"
    | "getPerpsAccountState"
    | "getSpotSymbols"
    | "getPerpsSymbols"
  >;
  builderId: bigint;
  /** Account builder được miễn builder fee (DEC-47); false = thu như mọi account (DEC-124). Thiếu = true. */
  builderExempt?: boolean | undefined;
  /** Giá gần nhất do marketdata ghi (Redis `md:last:<market>`). */
  lastPrice: (market: string) => Promise<{ price: string; at: number } | null>;
  /** Giá gần nhất của nhiều market một lần (MGET); market thiếu giá thì không có key. */
  prices: (markets: readonly string[]) => Promise<Record<string, string>>;
  /** Signer giải mã thử key (UI_REVIEW H1). Không có (test cũ) thì chỉ xét trạng thái và hạn trong DB. */
  verifyApiKey?: (id: string) => Promise<"ok" | "unusable" | "unavailable">;
}

/** Admin đã bật bot khối lượng cho tài khoản này chưa (Users › Volume bots, DEC-80). */
/** AI Desk do team bật theo tài khoản (DEC-105). */
export async function aiDeskOn(db: Db, userId: string): Promise<boolean> {
  const [u] = await db
    .select({ on: users.aiDesk })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return u?.on === true;
}

/** AI Adaptive DCA (thử nghiệm, DEC-107): cờ riêng, không còn đi theo AI Desk (DEC-192). */
export async function adaptiveDcaOn(db: Db, userId: string): Promise<boolean> {
  const [u] = await db
    .select({ on: users.adaptiveDca })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return u?.on === true;
}

export async function volumeBotsOn(db: Db, userId: string): Promise<boolean> {
  const [u] = await db
    .select({ on: users.volumeBots })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return u?.on === true;
}

/** Bot khối lượng như không tồn tại với tài khoản chưa được bật (DEC-80, thay VOLUME_MAKER_ENABLED). */
export async function assertStrategyAvailable(
  db: Db,
  userId: string,
  strategy: string,
): Promise<void> {
  if (
    (VOLUME_STRATEGIES as readonly string[]).includes(strategy) &&
    !(await volumeBotsOn(db, userId))
  )
    throw new AppError(ErrorCode.notFound, "Strategy not available.");
  // AI Adaptive DCA (thử nghiệm, DEC-107): cờ riêng. Copy Trade (DEC-161) đi theo AI Desk (DEC-192).
  if (strategy === Strategy.adaptiveDca && !(await adaptiveDcaOn(db, userId)))
    throw new AppError(ErrorCode.notFound, "Strategy not available.");
  if (
    (EXPERIMENTAL_STRATEGIES as readonly string[]).includes(strategy) &&
    strategy !== Strategy.adaptiveDca &&
    !(await aiDeskOn(db, userId))
  )
    throw new AppError(ErrorCode.notFound, "Strategy not available.");
}

/**
 * Start / Resume một bot đã có mà team đã tắt chiến lược cho tài khoản (bot khối lượng DEC-80, Adaptive DCA
 * DEC-218): engine sẽ không nạp bot đó, nên báo rõ thay vì để bot kẹt Starting / Resuming.
 */
export async function assertStrategyRunnable(
  db: Db,
  userId: string,
  strategy: string,
): Promise<void> {
  try {
    await assertStrategyAvailable(db, userId, strategy);
  } catch (e) {
    if (e instanceof AppError && e.code === ErrorCode.notFound)
      throw new AppError(
        ErrorCode.botStateConflict,
        "This strategy is turned off for your account.",
        { reason: "strategy_off" },
      );
    throw e;
  }
}

/**
 * Volume Farm isolated: stop loss phải chạy trước thanh lý (DEC-87). Thanh lý ở khoảng 100 / đòn bẩy % giá; lấy 90%
 * mức đó làm trần vì còn phí và maintenance margin. Cross dùng cả số dư account nên không có mức cố định để chặn.
 * Ở api, không ở schema: bot đang chạy với cấu hình cũ vẫn phải nạp được.
 */
export function assertFarmStop(strategy: string, config: Record<string, unknown>): void {
  if (strategy !== Strategy.volumeFarm || config.marginMode !== "isolated") return;
  const leverage = Number(config.leverage);
  if (!(leverage > 0) || typeof config.slPct !== "string") return;
  const max = new Decimal(90).div(leverage).toDecimalPlaces(2, Decimal.ROUND_DOWN);
  if (dec(config.slPct).gte(max)) {
    throw new AppError(ErrorCode.validationFailed, "Invalid bot settings.", {
      fieldErrors: {
        slPct: [`Past liquidation at ${String(leverage)}× isolated. Use below ${max.toString()}%.`],
      },
    });
  }
}

/** Copy Trade (DEC-161, DEC-163): ví leader không được là ví của chính người dùng. Nguồn: SoDEX hoặc Hyperliquid. */
export function assertCopyLeader(
  strategy: string,
  config: Record<string, unknown>,
  ownAddress: string,
): void {
  if (strategy !== Strategy.copyTrade) return;
  if (String(config.leaderAddress).toLowerCase() === ownAddress.toLowerCase())
    throw new AppError(ErrorCode.validationFailed, "Invalid bot settings.", {
      fieldErrors: { leaderAddress: ["You can't copy your own wallet."] },
    });
}

const LIVE_STATES = [
  BotState.starting,
  BotState.running,
  BotState.pausing,
  BotState.paused,
  BotState.resuming,
  BotState.stopping,
];

/** Market một bot đang giữ trên SoDEX Perps / Spot (để xét trùng với bot copy). */
function heldMarkets(strategy: string, market: string, config: unknown): string[] {
  const c = (config ?? {}) as Record<string, unknown>;
  const out = new Set<string>([market, ...copyMarkets(c)]);
  if (strategy === Strategy.fundingArb && typeof c.perpMarket === "string") out.add(c.perpMarket);
  return [...out];
}

export interface CopyClash {
  market: string;
  botId: string;
  botName: string;
}

/**
 * SoDEX gộp vị thế theo account + symbol: bot copy và bot thật khác cùng market bù trừ vị thế của nhau. Trả các market
 * trùng (DEC-163 mục 6: luồng tạo copy bỏ các market này và báo ở Review; Start sau này mà trùng thì chặn).
 */
export async function copyClashes(
  deps: BotDeps,
  sodexAccountId: string,
  strategy: string,
  markets: readonly string[],
  selfId: string | null,
): Promise<CopyClash[]> {
  const others = await deps.db
    .select({
      id: bots.id,
      name: bots.name,
      strategy: bots.strategy,
      market: bots.market,
      config: botVersions.config,
    })
    .from(bots)
    .leftJoin(botVersions, eq(botVersions.id, bots.activeVersionId))
    .where(
      and(
        eq(bots.sodexAccountId, sodexAccountId),
        eq(bots.mode, "live"),
        inArray(bots.state, LIVE_STATES),
      ),
    );
  const out: CopyClash[] = [];
  for (const o of others) {
    if (o.id === selfId) continue;
    // Chỉ xét khi một trong hai bên là bot copy.
    if (strategy !== Strategy.copyTrade && o.strategy !== Strategy.copyTrade) continue;
    const held = heldMarkets(o.strategy, o.market, o.config);
    for (const m of markets)
      if (held.includes(m) && !out.some((x) => x.market === m))
        out.push({ market: m, botId: o.id, botName: o.name });
  }
  return out;
}

async function assertCopyMarketFree(deps: BotDeps, own: typeof bots.$inferSelect): Promise<void> {
  if (own.mode !== "live") return;
  const [v] = await deps.db
    .select({ config: botVersions.config })
    .from(botVersions)
    .where(eq(botVersions.id, own.activeVersionId ?? "00000000-0000-0000-0000-000000000000"))
    .limit(1);
  const clash = (
    await copyClashes(
      deps,
      own.sodexAccountId,
      own.strategy,
      heldMarkets(own.strategy, own.market, v?.config),
      own.id,
    )
  )[0];
  if (clash !== undefined)
    throw new AppError(
      ErrorCode.botStateConflict,
      `${clash.botName} already trades ${clash.market}. Copy bots need the market to themselves.`,
      { botId: clash.botId, market: clash.market },
    );
}

/** Số trader Hyperliquid được copy realtime cùng lúc (1 IP, WS 10 ví; chừa 2 để đổi ví — DEC-163 mục 10). */
export const COPY_REALTIME_SLOTS = 8;

/** Trạng thái chỗ copy của một trader: đã có người copy thì luôn copy được; hết chỗ → "Follow · copy later". */
export async function copySlotOf(db: Db, address: string): Promise<"open" | "full" | "copied"> {
  const copied = await copiedLeaders(db, "hyperliquid");
  if (copied.includes(address.toLowerCase())) return "copied";
  return copied.length >= COPY_REALTIME_SLOTS ? "full" : "open";
}

/**
 * Trước khi chạy bot copy Hyperliquid (DEC-163 mục 5, 10): trader phải có thống kê và typical hold 30 ngày ≥ 15 phút
 * (minHoldFilter), và còn chỗ copy realtime.
 */
export async function assertCopyLeaderReady(
  deps: BotDeps,
  config: Record<string, unknown>,
): Promise<void> {
  if (config.leaderSource !== "hyperliquid") return;
  const address = String(config.leaderAddress).toLowerCase();
  const holds = await latestTypicalHold(deps.db, "hyperliquid", [address]);
  if (!holds.has(address))
    throw new AppError(ErrorCode.validationFailed, "We don't have this trader's history yet.", {
      reason: "no_stats",
    });
  if (!meetsMinHold({ typicalHoldMs: holds.get(address) ?? null }))
    throw new AppError(
      ErrorCode.validationFailed,
      "This trader trades too fast to copy (typical hold under 15 minutes).",
      { reason: "min_hold" },
    );
  if ((await copySlotOf(deps.db, address)) === "full")
    throw new AppError(
      ErrorCode.stateConflict,
      "All copy slots are taken. Follow this trader and copy later.",
      {
        reason: "slots_full",
      },
    );
}

export function parseConfig(strategy: string, config: unknown): Record<string, unknown> {
  const entry = (
    STRATEGIES as Record<
      string,
      | {
          schema: {
            safeParse: (v: unknown) => {
              success: boolean;
              data?: unknown;
              error?: { issues: { path: PropertyKey[]; message: string }[] };
            };
          };
        }
      | undefined
    >
  )[strategy];
  if (entry === undefined) throw new AppError(ErrorCode.validationFailed, "Unknown strategy.");
  const parsed = entry.schema.safeParse(config);
  if (!parsed.success) {
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of parsed.error?.issues ?? [])
      (fieldErrors[issue.path.map(String).join(".") || "_"] ??= []).push(issue.message);
    throw new AppError(ErrorCode.validationFailed, "Invalid bot settings.", { fieldErrors });
  }
  const out = parsed.data as Record<string, unknown>;
  assertFarmStop(strategy, out);
  return out;
}

/**
 * Trần đòn bẩy (STRATEGIES.md "Quy ước chung"): ≤ min(Max leverage của account ở Risk Center nếu đã đặt,
 * `maxLeverage` SoDEX của market). Vượt thì trả lỗi field `leverage`, không lưu.
 */
async function assertLeverageCap(
  deps: BotDeps,
  sodexAccountId: string,
  strategy: string,
  config: Record<string, unknown>,
): Promise<void> {
  if (typeof config.leverage !== "number") return;
  const markets =
    strategy === Strategy.fundingArb && typeof config.perpMarket === "string"
      ? [config.perpMarket]
      : strategy === Strategy.copyTrade
        ? copyMarkets(config)
        : [config.market];
  const all = await deps.rest.getPerpsSymbols();
  const symbols = markets.map((m) => all.find((s) => s.name === m));
  if (symbols.some((x) => x === undefined)) {
    throw new AppError(ErrorCode.validationFailed, "Invalid bot settings.", {
      fieldErrors: { leverage: ["Market not found on SoDEX."] },
    });
  }
  // Nhiều market (Copy Trade): trần là market có maxLeverage thấp nhất.
  const symbol = { maxLeverage: Math.min(...symbols.map((x) => x?.maxLeverage ?? 0)) };
  const [limits] = await deps.db
    .select({ maxLeverage: riskLimits.maxLeverage })
    .from(riskLimits)
    .where(eq(riskLimits.sodexAccountId, sodexAccountId))
    .limit(1);
  const accountCap =
    limits?.maxLeverage == null ? Number.POSITIVE_INFINITY : Number(limits.maxLeverage);
  const issue = leverageCapIssue(config.leverage, accountCap, symbol.maxLeverage);
  if (issue !== null) {
    throw new AppError(ErrorCode.validationFailed, "Invalid bot settings.", {
      fieldErrors: { leverage: [issue] },
    });
  }
}

export async function account(db: Db, userId: string) {
  const [a] = await db
    .select()
    .from(sodexAccounts)
    .where(and(eq(sodexAccounts.userId, userId), eq(sodexAccounts.status, "connected")))
    .orderBy(desc(sodexAccounts.createdAt))
    .limit(1);
  if (a === undefined) throw new AppError(ErrorCode.notFound, "No SoDEX account connected.");
  return a;
}

export async function ownBot(db: Db, userId: string, botId: string) {
  const [b] = await db
    .select()
    .from(bots)
    .where(and(eq(bots.id, botId), eq(bots.userId, userId)))
    .limit(1);
  if (b === undefined) throw new AppError(ErrorCode.botNotFound, "Bot not found.");
  return b;
}

/**
 * Lãi ròng của bot: đã chốt + chưa chốt theo giá hiện tại − phí − funding (DEC-88), để Profit since start chạy theo
 * giá như PnL ở Overview. Còn vị thế mà chưa có giá thì trả null, không hiện một con số thiếu phần chưa chốt.
 */
function netOf(
  state: unknown,
  marks: Readonly<Record<string, string>>,
  market: string,
  botState: BotState,
): string | null {
  // Bot đã dừng không còn quản lý vị thế; sổ cái có thể còn số cũ, không được tính lãi chưa chốt theo giá mới.
  const finished = botState === BotState.stopped || botState === BotState.archived;
  if (isMultiMarketCopyState(state)) {
    // Copy Trade nhiều market (DEC-163): đã chốt − phí − funding của mọi market + chưa chốt theo giá từng market.
    const t = copyLedgerTotals(state);
    let net = dec(t.realized).sub(t.fees).sub(t.funding);
    if (finished) return net.toString();
    for (const p of t.positions) {
      const mark = marks[p.market];
      if (mark === undefined) return null;
      net = net.add(dec(p.ledger.position).mul(dec(mark).sub(p.ledger.avgCost)));
    }
    return net.toString();
  }
  const l = (state as { ledger?: Ledger } | null)?.ledger;
  if (l === undefined) return null;
  const position = dec(l.position);
  if (finished || position.isZero()) return dec(l.realized).sub(l.fees).sub(l.funding).toString();
  const mark = marks[market];
  return mark === undefined ? null : netPnl(l, mark).toString();
}

/** Market cần giá để tính lãi của bot: `bots.market`, cộng mọi market của bot copy (DEC-163). */
export function priceMarketsOf(market: string, strategy: string, config: unknown): string[] {
  if (strategy !== Strategy.copyTrade || config === null || typeof config !== "object")
    return [market];
  return [...new Set([market, ...copyMarkets(config as Record<string, unknown>)])];
}

/** Rebalancing chạy cả rổ: nhãn là tên các tài sản ("BTC · ETH · USDC") thay cho market của tài sản đầu. */
function marketLabelOf(strategy: string, config: unknown): string | null {
  if (config === null || typeof config !== "object") return null;
  // Copy Trade nhiều market (DEC-163): "BTC · ETH · SOL".
  if (strategy === Strategy.copyTrade) {
    const ms = copyMarkets(config as Record<string, unknown>);
    return ms.length <= 1 ? null : ms.map((m) => m.split(/[-_]/)[0] ?? m).join(" · ");
  }
  if (strategy !== Strategy.rebalancing) return null;
  const assets = (config as { assets?: unknown }).assets;
  if (!Array.isArray(assets)) return null;
  const names = assets
    .map((a) => (a as { asset?: unknown }).asset)
    .filter((a): a is string => typeof a === "string" && a !== "");
  return names.length === 0 ? null : names.join(" · ");
}

/** "Waiting for price" (DEC-91): điều kiện chờ tính từ config và state của engine, mốc thời gian đổi sang ISO. */
function waitingView(strategy: string, config: unknown, state: unknown): BotSummary["waiting"] {
  const w = waitingOf(strategy, config, state);
  if (w === null) return null;
  if (w.kind === "cooldown") return { kind: "cooldown", until: new Date(w.until).toISOString() };
  if (w.kind === "start_at") return { kind: "start_at", at: new Date(w.at).toISOString() };
  return w;
}

export function summary(
  b: typeof bots.$inferSelect,
  version: number | null,
  state: unknown,
  config: unknown = null,
  fills = 0,
  marks: Readonly<Record<string, string>> = {},
): BotSummary {
  return {
    id: b.id,
    name: b.name,
    strategy: b.strategy as BotSummary["strategy"],
    market: b.market,
    engine: b.engine,
    state: b.state,
    reasonCode: (b.reasonCode as BotSummary["reasonCode"]) ?? null,
    needsAttention: b.needsAttention,
    activeVersion: version,
    netPnl: netOf(state, marks, b.market, b.state),
    ...botCapitalOf(b.strategy, config),
    marketLabel: marketLabelOf(b.strategy, config),
    fills,
    waiting: b.state === BotState.running ? waitingView(b.strategy, config, state) : null,
    mode: b.mode,
    createdAt: iso(b.createdAt),
    updatedAt: iso(b.updatedAt),
  };
}

export async function createBot(
  deps: BotDeps,
  userId: string,
  body: CreateBotBody,
  ip: string | null,
): Promise<BotSummary> {
  await assertStrategyAvailable(deps.db, userId, body.strategy);
  const a = await account(deps.db, userId);
  const config = parseConfig(body.strategy, body.config);
  assertCopyLeader(body.strategy, config, a.address);
  await assertLeverageCap(deps, a.id, body.strategy, config);
  const req = requirementOf(body.strategy, config);
  const bot = await deps.db.transaction(async (tx) => {
    const [b] = await tx
      .insert(bots)
      .values({
        userId,
        sodexAccountId: a.id,
        strategy: body.strategy,
        market: req.market,
        engine: req.engine,
        name: body.name,
        state: BotState.draft,
      })
      .returning();
    if (b === undefined) throw new AppError(ErrorCode.internal, "Could not create bot.");
    const [v] = await tx
      .insert(botVersions)
      .values({
        botId: b.id,
        version: 1,
        config,
        paramSource: body.paramSource,
        aiSuggestionId: body.aiSuggestionId ?? null,
        status: "active",
        appliedAt: new Date(),
      })
      .returning();
    const [updated] = await tx
      .update(bots)
      .set({ activeVersionId: v?.id ?? null })
      .where(eq(bots.id, b.id))
      .returning();
    return updated ?? b;
  });
  await audit(deps.db, { userId, action: AuditAction.botCreated, target: bot.id, ip });
  return summary(bot, 1, null);
}

export async function listBots(
  deps: BotDeps,
  userId: string,
  withArchived = false,
): Promise<BotSummary[]> {
  const rows = await deps.db
    .select({
      bot: bots,
      version: botVersions.version,
      state: botRuntime.state,
      // Cấu hình đang chạy; draft chưa có version active thì lấy version mới nhất.
      config: sql<unknown>`coalesce(${botVersions.config}, (select bv.config from bot_versions bv where bv.bot_id = ${bots.id} order by bv.version desc limit 1))`,
      fills: sql<number>`(select count(*)::int from orders o where o.bot_id = ${bots.id} and o.status in ('filled', 'partially_filled'))`,
    })
    .from(bots)
    .leftJoin(botVersions, eq(botVersions.id, bots.activeVersionId))
    .leftJoin(botRuntime, eq(botRuntime.botId, bots.id))
    .where(
      and(eq(bots.userId, userId), withArchived ? undefined : sql`${bots.state} <> 'archived'`),
    )
    .orderBy(desc(bots.updatedAt));
  const marks: Record<string, string> = await deps
    .prices(rows.flatMap((r) => priceMarketsOf(r.bot.market, r.bot.strategy, r.config)))
    .catch(() => ({}));
  return rows.map((r) => summary(r.bot, r.version, r.state, r.config, r.fills, marks));
}

async function vmStats(
  deps: BotDeps,
  botId: string,
  strategy: string,
  config: unknown,
  state: unknown,
  /** Lúc version đang chạy bắt đầu: state của engine (phiên) tính từ đây, builder fee cũng cộng từ đây. */
  sessionFrom: Date,
): Promise<BotDetail["volumeMaker"]> {
  if (strategy !== Strategy.volumeMaker || state === null || config === null) return null;
  const c = config as { volumeTarget?: string; costBudget: string };
  const st = state as VolumeMakerState;
  // Cơ cấu chi phí (DEC-136): builder fee của phiên lấy từ fill thật của bot.
  const [bf] = await deps.db
    .select({ builder: sql<string>`coalesce(sum(${fills.builderFee}), 0)::text` })
    .from(fills)
    .innerJoin(orders, eq(orders.id, fills.orderId))
    .where(and(eq(orders.botId, botId), gte(fills.filledAt, sessionFrom)));
  const l = st.ledger;
  const builder = Decimal.min(dec(l.fees), dec(bf?.builder ?? "0"));
  const openPnl = st.mid === null ? dec("0") : dec(l.position).mul(dec(st.mid).sub(l.avgCost));
  const breakdown = {
    sodexFees: Decimal.max(0, dec(l.fees).sub(builder)).toDecimalPlaces(4).toString(),
    builderFees: builder.toDecimalPlaces(4).toString(),
    pricePnl: dec(l.realized).toDecimalPlaces(4).toString(),
    openPnl: openPnl.toDecimalPlaces(4).toString(),
    funding: dec(l.funding).toDecimalPlaces(4).toString(),
  };
  return {
    ...breakdown,
    volume: st.volume,
    volumeTarget: c.volumeTarget ?? null,
    cost: costUsed(st).toDecimalPlaces(4).toString(),
    costBudget: c.costBudget,
    costPerMillion: costPerMillion(st),
    makerSharePct: dec(st.volume).isZero()
      ? null
      : dec(st.makerVolume).div(st.volume).mul(100).toDecimalPlaces(2).toString(),
    inventory: st.ledger.position,
    selfTradeBlocked: st.selfTradeBlocked,
  };
}

/** Khối lượng theo kỳ của Volume Farm (DEC-83), tính trên fill thật của bot. */
async function vfStats(
  deps: BotDeps,
  botId: string,
  config: unknown,
  state: unknown,
  /** Lúc version đang chạy bắt đầu: phiên (state engine) tính từ đây, builder fee cũng cộng từ đây. */
  sessionFrom: Date,
): Promise<BotDetail["volumeFarm"]> {
  if (config === null) return null;
  const now = deps.now();
  const since = (ms: number) => new Date(now.getTime() - ms);
  const notional = sql`${fills.price} * ${fills.size}`;
  const sumSince = (from: Date) =>
    sql<string>`coalesce(sum(${notional}) filter (where ${fills.filledAt} >= ${from.toISOString()}::timestamptz), 0)::text`;
  const [v] = await deps.db
    .select({
      h1: sumSince(since(3_600_000)),
      h24: sumSince(since(86_400_000)),
      d7: sumSince(since(7 * 86_400_000)),
      total: sql<string>`coalesce(sum(${notional}), 0)::text`,
      maker: sql<string>`coalesce(sum(${notional}) filter (where ${fills.isMaker}), 0)::text`,
      builder: sql<string>`coalesce(sum(${fills.builderFee}) filter (where ${fills.filledAt} >= ${sessionFrom.toISOString()}::timestamptz), 0)::text`,
    })
    .from(fills)
    .innerJoin(orders, eq(orders.id, fills.orderId))
    .where(eq(orders.botId, botId));
  const st = (state ?? volumeFarm.initialState(config as never)) as VolumeFarmState;
  const net = farmNet(st);
  const volume = dec(st.volume);
  const total = dec(v?.total ?? "0");
  const money = (x: string | undefined) =>
    dec(x ?? "0")
      .toDecimalPlaces(2)
      .toString();
  return {
    session: {
      volume: volume.toDecimalPlaces(2).toString(),
      trades: st.trades,
      wins: st.wins,
      winRatePct:
        st.trades === 0
          ? null
          : dec(String(st.wins)).div(st.trades).mul(100).toDecimalPlaces(1).toString(),
      fees: dec(st.ledger.fees).toDecimalPlaces(4).toString(),
      // Builder fee nằm sẵn trong fee của mỗi fill (SODEX.md 5.3): tách ra, không cộng thêm.
      sodexFees: Decimal.max(0, dec(st.ledger.fees).sub(v?.builder ?? "0"))
        .toDecimalPlaces(4)
        .toString(),
      builderFees: dec(v?.builder ?? "0")
        .toDecimalPlaces(4)
        .toString(),
      pricePnl: dec(st.ledger.realized).toDecimalPlaces(4).toString(),
      funding: dec(st.ledger.funding).toDecimalPlaces(4).toString(),
      net: net.toDecimalPlaces(4).toString(),
      costPerMillion: volume.isZero()
        ? null
        : Decimal.max(0, net.neg()).div(volume).mul(1_000_000).toDecimalPlaces(2).toString(),
    },
    volume1h: money(v?.h1),
    volume24h: money(v?.h24),
    volume7d: money(v?.d7),
    volumeTotal: money(v?.total),
    makerSharePct: total.isZero()
      ? null
      : dec(v?.maker ?? "0")
          .div(total)
          .mul(100)
          .toDecimalPlaces(1)
          .toString(),
    volumeTarget: (config as { volumeTarget?: string }).volumeTarget ?? null,
    position: st.ledger.position,
  };
}

export async function botDetail(deps: BotDeps, userId: string, botId: string): Promise<BotDetail> {
  const b = await ownBot(deps.db, userId, botId);
  const versions = await deps.db
    .select()
    .from(botVersions)
    .where(eq(botVersions.botId, botId))
    .orderBy(desc(botVersions.version));
  const events = await deps.db
    .select()
    .from(botEvents)
    .where(eq(botEvents.botId, botId))
    .orderBy(desc(botEvents.occurredAt))
    .limit(50);
  const [runtime] = await deps.db
    .select()
    .from(botRuntime)
    .where(eq(botRuntime.botId, botId))
    .limit(1);
  // Runtime cần mốc "Running" gần nhất; bot ghi nhiều sự kiện (Volume Farm) đẩy mốc này ra khỏi 50 sự kiện ở trên.
  const [since] =
    b.state === BotState.running
      ? await deps.db
          .select({ at: botEvents.occurredAt })
          .from(botEvents)
          .where(
            and(
              eq(botEvents.botId, botId),
              eq(botEvents.type, "state"),
              eq(botEvents.decision, "Running"),
            ),
          )
          .orderBy(desc(botEvents.occurredAt))
          .limit(1)
      : [];
  const [open] = await deps.db
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .where(and(eq(orders.botId, botId), inArray(orders.status, ["open", "partially_filled"])));
  const [filled] = await deps.db
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .where(and(eq(orders.botId, botId), inArray(orders.status, ["filled", "partially_filled"])));
  const active = versions.find((v) => v.id === b.activeVersionId);
  const marks: Record<string, string> = await deps
    .prices(priceMarketsOf(b.market, b.strategy, active?.config ?? null))
    .catch(() => ({}));
  return {
    // Cùng công thức vốn với danh sách (`GET /bots`), để hai endpoint thống nhất (UI_REVIEW F7).
    bot: summary(
      b,
      active?.version ?? null,
      runtime?.state ?? null,
      active?.config ?? null,
      filled?.n ?? 0,
      marks,
    ),
    versions: versions.map((v) => ({
      id: v.id,
      version: v.version,
      config: v.config as Record<string, unknown>,
      paramSource: v.paramSource,
      status: v.status,
      createdAt: iso(v.createdAt),
      appliedAt: v.appliedAt === null ? null : iso(v.appliedAt),
    })),
    events: events.map((e) => ({
      id: e.id,
      type: e.type,
      decision: e.decision,
      why: e.why,
      result: e.result,
      occurredAt: iso(e.occurredAt),
    })),
    openOrders: open?.n ?? 0,
    serverTime: iso(deps.now()),
    runningSince: since === undefined ? null : iso(since.at),
    volumeMaker: await vmStats(
      deps,
      botId,
      b.strategy,
      active?.config ?? null,
      runtime?.state ?? null,
      active?.appliedAt ?? active?.createdAt ?? b.createdAt,
    ),
    volumeFarm:
      b.strategy === Strategy.volumeFarm
        ? await vfStats(
            deps,
            botId,
            active?.config ?? null,
            runtime?.state ?? null,
            active?.appliedAt ?? active?.createdAt ?? b.createdAt,
          )
        : null,
    adaptiveDca: adcaStats(b.strategy, active?.config ?? null, runtime?.state ?? null),
  };
}

/** Chỉ số AI Adaptive DCA từ state của engine (DEC-107); chưa chạy thì null. */
function adcaStats(strategy: string, config: unknown, state: unknown): BotDetail["adaptiveDca"] {
  if (strategy !== Strategy.adaptiveDca || state === null || config === null) return null;
  const c = config as { maxSafetyOrders?: number; maxExposure?: string };
  const st = state as Partial<AdaptiveDcaState>;
  if (st.ledger === undefined) return null;
  return {
    regime: st.regime ?? "UNKNOWN",
    atr: st.atr ?? null,
    rsi: st.rsi === null || st.rsi === undefined ? null : st.rsi.toFixed(1),
    decision: st.decision ?? "continue",
    phase: st.phase ?? "idle",
    extraBuys: st.safetiesFilled ?? 0,
    maxExtraBuys: c.maxSafetyOrders ?? 0,
    exposure: dec(st.ledger.position).abs().mul(st.ledger.avgCost).toDecimalPlaces(2).toString(),
    maxExposure: c.maxExposure ?? "0",
    cycles: st.completedCycles ?? 0,
    exits: st.exits ?? 0,
  };
}

export async function rulesFor(deps: BotDeps, market: string): Promise<MarketRules | undefined> {
  const [spot, perps] = await Promise.all([
    deps.rest.getSpotSymbols(),
    deps.rest.getPerpsSymbols(),
  ]);
  const s = spot.find((x) => x.name === market) ?? perps.find((x) => x.name === market);
  return s === undefined
    ? undefined
    : {
        tickSize: s.tickSize,
        stepSize: s.stepSize,
        minQuantity: s.minQuantity,
        minNotional: s.minNotional,
      };
}

/** "Before it starts" (SCREENS.md mục 8.2): mọi mục đạt thì Start mới bật. */
export async function startChecks(
  deps: BotDeps,
  userId: string,
  botId: string,
): Promise<StartChecks> {
  const b = await ownBot(deps.db, userId, botId);
  const [version] = await deps.db
    .select()
    .from(botVersions)
    .where(eq(botVersions.id, b.activeVersionId ?? ""))
    .limit(1);
  const [a] = await deps.db
    .select()
    .from(sodexAccounts)
    .where(eq(sodexAccounts.id, b.sodexAccountId))
    .limit(1);
  if (version === undefined || a === undefined)
    throw new AppError(ErrorCode.botNotFound, "Bot not found.");
  return checksFor(deps, userId, a, b.strategy, version.config as Record<string, unknown>, b.id);
}

/**
 * Dry run cho form chưa lưu (UI_REVIEW H2): cùng logic với draft đã lưu, không ghi DB. Config phải hợp lệ
 * theo zod schema của chiến lược (lỗi field trả như khi lưu).
 */
export async function dryRunChecks(
  deps: BotDeps,
  userId: string,
  body: { strategy: string; config: unknown },
): Promise<StartChecks> {
  await assertStrategyAvailable(deps.db, userId, body.strategy);
  const a = await account(deps.db, userId);
  const config = parseConfig(body.strategy, body.config);
  assertCopyLeader(body.strategy, config, a.address);
  return checksFor(deps, userId, a, body.strategy, config);
}

async function checksFor(
  deps: BotDeps,
  userId: string,
  a: typeof sodexAccounts.$inferSelect,
  strategy: string,
  config: Record<string, unknown>,
  /** Bot đang kiểm tra (bỏ khỏi danh sách bot khác khi xét xung đột đòn bẩy). */
  selfId: string | null = null,
): Promise<StartChecks> {
  const [key] = await deps.db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.sodexAccountId, a.id), eq(apiKeys.status, "active")))
    .orderBy(desc(apiKeys.createdAt))
    .limit(1);
  const b = { strategy };
  const req = requirementOf(b.strategy, config);
  const address = getAddress(a.address);
  const now = deps.now().getTime();

  // Key phải còn hạn **và** signer giải mã được (UI_REVIEW H1): key active nhưng không ký được thì ✕.
  const keyUsable =
    key === undefined || deps.verifyApiKey === undefined ? "ok" : await deps.verifyApiKey(key.id);
  const keyOk = key !== undefined && key.expiresAt.getTime() > now && keyUsable === "ok";
  // Account của chính builder không thu phí của chính mình (DEC-47).
  const exempt = isBuilderAccount(a.sodexAccountId, deps.builderId, deps.builderExempt);
  let feeOk = exempt;
  if (!exempt) {
    try {
      feeOk = readDriftApproval(
        await deps.rest.getBuilderApprovals(address),
        deps.builderId,
      ).approved;
    } catch {
      feeOk = false;
    }
  }
  // Perps: margin dùng được theo margin mode của bot (UI_REVIEW I3, DEC-58): Cross → `am` (đã haircut theo
  // collateral ratio), Isolated → `ami` (chỉ USDC). Không so với `av` (chưa haircut).
  const specs = leverageSpecsOf(b.strategy, req.market, config);
  const spec = specs[0] ?? null;
  let perpsState: Awaited<ReturnType<BotDeps["rest"]["getPerpsAccountState"]>> | null = null;
  if (req.engine !== "spot") {
    perpsState = await deps.rest.getPerpsAccountState(address).catch(() => null);
  }
  const usableMargin = (marginMode: "cross" | "isolated") =>
    perpsState === null ? null : marginMode === "isolated" ? perpsState.ami : perpsState.am;
  let balanceOk = false;
  let balanceDetail: string | null = null;
  let balanceData: Record<string, string | null> = { needed: req.capital };
  try {
    if (req.engine === "perps") {
      const usable = usableMargin(spec?.marginMode ?? "cross");
      balanceOk = usable !== null && dec(usable).gte(req.capital);
      balanceDetail = usable;
      balanceData = {
        available: usable,
        needed: req.capital,
        usableMargin: perpsState?.am ?? null,
        isolated: perpsState?.ami ?? null,
        marginMode: spec?.marginMode ?? "cross",
      };
    } else {
      const quote = req.market.split("_")[1] ?? "vUSDC";
      const bal = (await deps.rest.getSpotBalances(address, a.sodexAccountId)).find(
        (x) => x.coin === quote,
      );
      const free = bal === undefined ? null : dec(bal.total).sub(bal.locked).toString();
      balanceOk = free !== null && dec(free).gte(req.capital);
      balanceDetail = free;
      balanceData = { available: free, needed: req.capital };
      if (req.engine === "spot+perps") {
        // Funding Arb: nửa vốn cho chân perp, theo margin mode của chân perp (Cross).
        const usable = usableMargin(spec?.marginMode ?? "cross");
        balanceOk = balanceOk && usable !== null && dec(usable).gte(dec(req.capital).div(2));
      }
    }
  } catch {
    balanceOk = false;
  }

  // Xung đột đòn bẩy theo account + symbol (DEC-58): chặn khi có vị thế với thiết lập khác hoặc bot DRIFT khác
  // dùng cùng symbol với thiết lập khác; chỉ khác cài đặt thì ✓ kèm cảnh báo (UI bắt xác nhận riêng).
  let leverageCheck: StartChecks["checks"][number] | null = null;
  if (spec !== null) {
    const others = await deps.db
      .select({
        id: bots.id,
        name: bots.name,
        strategy: bots.strategy,
        market: bots.market,
        config: botVersions.config,
      })
      .from(bots)
      .innerJoin(botVersions, eq(botVersions.id, bots.activeVersionId))
      .where(
        and(
          eq(bots.sodexAccountId, a.id),
          // Bot paper không đặt đòn bẩy trên SoDEX nên không xung đột với bot thật (DEC-105).
          eq(bots.mode, "live"),
          inArray(bots.state, [
            BotState.starting,
            BotState.running,
            BotState.pausing,
            BotState.paused,
            BotState.resuming,
          ]),
        ),
      );
    const otherSpecs = others
      .filter((o) => o.id !== selfId)
      .flatMap((o) =>
        leverageSpecsOf(o.strategy, o.market, o.config).map((os) => ({ name: o.name, spec: os })),
      );
    if (perpsState === null) {
      leverageCheck = { key: CheckKey.leverageConflict, ok: false, detail: "unavailable" };
    } else {
      // Nhiều symbol (Copy Trade, DEC-163): báo symbol nặng nhất (chặn trước, rồi "changes").
      const state = perpsState;
      const results = specs.map((sp) => ({ sp, c: leverageConflict(sp, state, otherSpecs) }));
      const worst = results.find((x) => x.c.kind === "position" || x.c.kind === "bot") ??
        results.find((x) => x.c.kind === "changes") ??
        results[0] ?? { sp: spec, c: leverageConflict(spec, state, otherSpecs) };
      const c = worst.c;
      const spec_ = worst.sp;
      const base = {
        kind: c.kind,
        market: spec_.market,
        leverage: String(spec_.leverage),
        marginMode: spec_.marginMode,
      };
      leverageCheck = {
        key: CheckKey.leverageConflict,
        ok: c.kind === "none" || c.kind === "changes",
        detail: c.kind,
        data:
          c.kind === "bot"
            ? {
                ...base,
                botName: c.botName,
                currentLeverage: String(c.other.leverage),
                currentMode: c.other.marginMode,
              }
            : c.kind === "none"
              ? base
              : {
                  ...base,
                  currentLeverage: String(c.current.leverage),
                  currentMode: c.current.marginMode,
                },
      };
    }
  }
  const last = await deps.lastPrice(req.market);
  let fresh = last !== null && now - last.at <= PRICE_FRESH_MS;
  // Copy Trade nhiều market (DEC-163): mọi market đều phải có giá mới.
  for (const m of priceMarketsOf(req.market, b.strategy, config).filter((x) => x !== req.market)) {
    const l = await deps.lastPrice(m);
    fresh = fresh && l !== null && now - l.at <= PRICE_FRESH_MS;
  }
  let minOk = false;
  let minData: Record<string, string | null> | undefined;
  const rules = await rulesFor(deps, req.market).catch(() => undefined);
  if (rules !== undefined && last !== null) {
    minOk = meetsMinSize(b.strategy, config, rules, last.price);
    if (!minOk) {
      const d = minSizeDetail(b.strategy, config, rules, last.price);
      minData = {
        smallest: d.smallest,
        required: d.required,
        capitalField: d.capitalField,
        suggestedCapital: d.suggestedCapital,
      };
    }
  }

  const checks = [
    {
      key: CheckKey.apiKey,
      ok: keyOk,
      detail: keyUsable !== "ok" ? keyUsable : key === undefined ? null : iso(key.expiresAt),
    },
    { key: CheckKey.builderFee, ok: feeOk, detail: exempt ? "exempt" : null },
    { key: CheckKey.balance, ok: balanceOk, detail: balanceDetail, data: balanceData },
    {
      key: CheckKey.minSize,
      ok: minOk,
      detail: null,
      ...(minData === undefined ? {} : { data: minData }),
    },
    // Giới hạn rủi ro của account đặt ở Risk Center (P10); chưa có giới hạn nào thì không chặn.
    { key: CheckKey.riskLimits, ok: true, detail: null },
    {
      key: CheckKey.freshPrice,
      ok: fresh,
      detail: last === null ? null : new Date(last.at).toISOString(),
    },
    ...(leverageCheck === null ? [] : [leverageCheck]),
  ];
  return { checks, allOk: checks.every((c) => c.ok) };
}

async function command(
  deps: BotDeps,
  userId: string,
  botId: string,
  cmd: BotCommand,
  extra?: Partial<typeof bots.$inferInsert>,
) {
  return deps.db.transaction(async (tx) => {
    const [b] = await tx
      .select()
      .from(bots)
      .where(and(eq(bots.id, botId), eq(bots.userId, userId)))
      .for("update");
    if (b === undefined) throw new AppError(ErrorCode.botNotFound, "Bot not found.");
    const next = applyCommand(b.state, cmd);
    if (next === null)
      throw new AppError(ErrorCode.botStateConflict, "Action not allowed in this state.", {
        state: b.state,
      });
    const [u] = await tx
      .update(bots)
      .set({ state: next, ...extra })
      .where(eq(bots.id, botId))
      .returning();
    await tx
      .insert(outbox)
      .values({ topic: `user.${b.sodexAccountId}.bot`, payload: { botId, state: next } });
    return u ?? b;
  });
}

export async function startBot(
  deps: BotDeps,
  userId: string,
  botId: string,
  input: { twoFactorCode?: string | undefined; acknowledged?: boolean | undefined },
  ip: string | null,
  sessionId?: string,
): Promise<BotSummary> {
  // Bot paper chỉ chạy từ AI Desk; luồng Start (2FA + kiểm tra tiền thật) chỉ dành cho bot thật (DEC-105).
  if ((await ownBot(deps.db, userId, botId)).mode === "paper")
    throw new AppError(ErrorCode.botStateConflict, "Fake-money tests start from AI Desk.");
  // 2FA chỉ hỏi khi người dùng đã bật, và không hỏi lại trong 2 giờ trên cùng phiên (DEC-115).
  await verifyTwoFactor(
    deps,
    userId,
    input.twoFactorCode,
    ip,
    sessionId === undefined ? {} : { sessionId },
  );
  if (input.acknowledged !== true)
    throw new AppError(ErrorCode.validationFailed, "Confirm before starting.", {
      fieldErrors: { acknowledged: ["required"] },
    });
  const checks = await startChecks(deps, userId, botId);
  if (!checks.allOk) {
    const failed = checks.checks.filter((c) => !c.ok).map((c) => c.key);
    if (failed.includes(CheckKey.builderFee))
      throw new AppError(ErrorCode.builderFeeNotApproved, "Builder fee is not approved.", {
        failed,
      });
    if (failed.includes(CheckKey.minSize))
      throw new AppError(ErrorCode.orderBelowMinSize, "An order is below SoDEX minimum size.", {
        failed,
      });
    throw new AppError(ErrorCode.validationFailed, "Start checks failed.", { failed });
  }
  const own = await ownBot(deps.db, userId, botId);
  // Team đã tắt chiến lược cho tài khoản: báo rõ, không để bot kẹt Starting (engine không nạp).
  await assertStrategyRunnable(deps.db, userId, own.strategy);
  // Draft lưu trước khi có quy tắc này vẫn bị chặn lúc Start.
  const [active] = await deps.db
    .select({ config: botVersions.config })
    .from(botVersions)
    .where(eq(botVersions.id, own.activeVersionId ?? ""))
    .limit(1);
  if (active !== undefined) assertFarmStop(own.strategy, active.config as Record<string, unknown>);
  await assertCopyMarketFree(deps, own);
  if (own.strategy === Strategy.copyTrade && own.mode === "live" && active !== undefined)
    await assertCopyLeaderReady(deps, active.config as Record<string, unknown>);
  if (own.state === BotState.stopped) await newRunVersion(deps, botId);
  const b = await command(deps, userId, botId, BotCommand.start, { reasonCode: null });
  await audit(deps.db, { userId, action: AuditAction.botStarted, target: botId, ip });
  return summary(b, null, null);
}

export async function pauseBot(deps: BotDeps, userId: string, botId: string): Promise<BotSummary> {
  return summary(await command(deps, userId, botId, BotCommand.pause), null, null);
}

/** Resume chỉ khi lý do pause đã hết (DOMAIN.md mục 7.2). */
export async function resumeBot(deps: BotDeps, userId: string, botId: string): Promise<BotSummary> {
  const b = await ownBot(deps.db, userId, botId);
  // Team đã tắt chiến lược cho tài khoản: báo rõ, không để bot kẹt Resuming (engine không nạp).
  await assertStrategyRunnable(deps.db, userId, b.strategy);
  if (
    b.reasonCode === ReasonCode.builderFeeRevoked ||
    b.reasonCode === ReasonCode.apiKeyExpired ||
    b.reasonCode === ReasonCode.apiKeyUnusable
  ) {
    const checks = await startChecks(deps, userId, botId);
    const need =
      b.reasonCode === ReasonCode.builderFeeRevoked ? CheckKey.builderFee : CheckKey.apiKey;
    if (checks.checks.find((c) => c.key === need)?.ok !== true) {
      throw new AppError(ErrorCode.botStateConflict, "The reason for the pause still applies.", {
        reasonCode: b.reasonCode,
      });
    }
  }
  // Pause vì rủi ro: chỉ resume khi alert tương ứng đã đóng (daily loss: sang ngày mới; drawdown: về dưới giới hạn).
  if (b.reasonCode === ReasonCode.riskDailyLoss || b.reasonCode === ReasonCode.riskDrawdown) {
    const kind = b.reasonCode === ReasonCode.riskDailyLoss ? "daily_loss" : "max_drawdown";
    const [open] = await deps.db
      .select({ id: riskAlerts.id })
      .from(riskAlerts)
      .where(
        and(
          eq(riskAlerts.sodexAccountId, b.sodexAccountId),
          eq(riskAlerts.kind, kind),
          isNull(riskAlerts.resolvedAt),
        ),
      )
      .limit(1);
    if (open !== undefined)
      throw new AppError(ErrorCode.botStateConflict, "The reason for the pause still applies.", {
        reasonCode: b.reasonCode,
      });
  }
  return summary(
    await command(deps, userId, botId, BotCommand.resume, { reasonCode: null }),
    null,
    null,
  );
}

export async function stopBot(
  deps: BotDeps,
  userId: string,
  botId: string,
  ip: string | null,
  closePosition = false,
): Promise<BotSummary> {
  const own = await ownBot(deps.db, userId, botId);
  // Dừng bot chỉ giảm rủi ro nên không hỏi 2FA (DEC-115, thay phần Stop của C12).
  // Chỉ bot có chân Perps mới có vị thế để đóng; bot Spot luôn giữ tài sản (DOMAIN.md 7.2).
  const close = closePosition && own.engine !== "spot";
  const b = await command(deps, userId, botId, BotCommand.stop, { closeOnStop: close });
  await audit(deps.db, {
    userId,
    action: AuditAction.botStopped,
    target: botId,
    metadata: { closePosition: close },
    ip,
  });
  return summary(b, null, null);
}

/** Archive (DEC-84): bot đã dừng rời My bots, lịch sử giữ nguyên, xem lại ở bộ lọc Archived. */
/** Khôi phục bot đã archive (DEC-88): về Stopped, từ đó Start again như mọi bot đã dừng. */
export async function unarchiveBot(
  deps: BotDeps,
  userId: string,
  botId: string,
): Promise<BotSummary> {
  const b = await command(deps, userId, botId, BotCommand.unarchive, { archivedAt: null });
  return summary(b, null, null);
}

export async function archiveBot(
  deps: BotDeps,
  userId: string,
  botId: string,
): Promise<BotSummary> {
  const b = await command(deps, userId, botId, BotCommand.archive, { archivedAt: deps.now() });
  return summary(b, null, null);
}

/**
 * Chạy lại bot đã dừng (DEC-86): tạo version mới cùng cấu hình trong chính bot đó. Version mới cho clOrdID mới
 * (clOrdID theo version, không trùng lệnh của lần chạy trước) và state mới; fill và Decisions cũ vẫn giữ.
 */
async function newRunVersion(deps: BotDeps, botId: string): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const [last] = await tx
      .select()
      .from(botVersions)
      .where(eq(botVersions.botId, botId))
      .orderBy(desc(botVersions.version))
      .limit(1);
    if (last === undefined) throw new AppError(ErrorCode.botNotFound, "Bot not found.");
    await tx
      .update(botVersions)
      .set({ status: "superseded" })
      .where(and(eq(botVersions.botId, botId), eq(botVersions.status, "active")));
    const [next] = await tx
      .insert(botVersions)
      .values({
        botId,
        version: last.version + 1,
        config: last.config,
        paramSource: last.paramSource,
        status: "active",
        appliedAt: deps.now(),
      })
      .returning({ id: botVersions.id });
    await tx
      .update(bots)
      .set({ activeVersionId: next?.id ?? null, closeOnStop: false })
      .where(eq(bots.id, botId));
  });
}

/** Sửa bot: tạo version mới `pending`; engine áp dụng rồi mới chuyển `active` (DOMAIN.md mục 7.4). */
export async function newVersion(
  deps: BotDeps,
  userId: string,
  botId: string,
  input: {
    config: unknown;
    paramSource: "ai" | "ai_edited" | "manual";
    aiSuggestionId?: string | undefined;
  },
) {
  const b = await ownBot(deps.db, userId, botId);
  // Bot đã dừng cũng sửa được (DEC-131): version mới thành version đang dùng ngay, Start lần sau chạy với nó.
  if (
    b.state !== BotState.running &&
    b.state !== BotState.paused &&
    b.state !== BotState.draft &&
    b.state !== BotState.stopped
  ) {
    throw new AppError(ErrorCode.botStateConflict, "Bot can't be edited in this state.", {
      state: b.state,
    });
  }
  const config = parseConfig(b.strategy, input.config);
  if (b.strategy === Strategy.copyTrade)
    assertCopyLeader(b.strategy, config, (await account(deps.db, userId)).address);
  // Khoá: strategy, market (SCREENS.md mục 8.4). Copy Trade: khoá cả trader và danh sách market (DEC-163).
  if (b.strategy === Strategy.copyTrade) {
    const [cur] = await deps.db
      .select({ config: botVersions.config })
      .from(botVersions)
      .where(eq(botVersions.botId, b.id))
      .orderBy(desc(botVersions.version))
      .limit(1);
    const before = (cur?.config ?? {}) as Record<string, unknown>;
    const same = (x: string[], y: string[]) => [...x].sort().join() === [...y].sort().join();
    if (!same(copyMarkets(before), copyMarkets(config)))
      throw new AppError(ErrorCode.validationFailed, "Markets can't change.", {
        fieldErrors: { markets: ["locked"] },
      });
    if (String(before.leaderAddress).toLowerCase() !== String(config.leaderAddress).toLowerCase())
      throw new AppError(ErrorCode.validationFailed, "Trader can't change.", {
        fieldErrors: { leaderAddress: ["locked"] },
      });
  }
  if (requirementOf(b.strategy, config).market !== b.market) {
    throw new AppError(ErrorCode.validationFailed, "Market can't change.", {
      fieldErrors: { market: ["locked"] },
    });
  }
  await assertLeverageCap(deps, b.sodexAccountId, b.strategy, config);
  return deps.db.transaction(async (tx) => {
    const [{ v } = { v: 0 }] = await tx
      .select({ v: max(botVersions.version) })
      .from(botVersions)
      .where(eq(botVersions.botId, botId));
    const version = (v ?? 0) + 1;
    const draft = b.state === BotState.draft || b.state === BotState.stopped;
    const [row] = await tx
      .insert(botVersions)
      .values({
        botId,
        version,
        config,
        paramSource: input.paramSource,
        aiSuggestionId: input.aiSuggestionId ?? null,
        status: draft ? "active" : "pending",
        appliedAt: draft ? new Date() : null,
      })
      .returning();
    if (draft && row !== undefined) {
      await tx
        .update(botVersions)
        .set({ status: "superseded" })
        .where(and(eq(botVersions.botId, botId), sql`${botVersions.id} <> ${row.id}`));
      await tx.update(bots).set({ activeVersionId: row.id }).where(eq(bots.id, botId));
    }
    return { version, status: row?.status ?? "pending" };
  });
}

/** Số đếm của trang Orders, trên toàn bộ lệnh của user (hoặc của một bot), không phụ thuộc giới hạn 200 dòng. */
export async function orderCounts(deps: BotDeps, userId: string, botId?: string) {
  const [u] = await deps.db
    .select({ tz: users.timezone })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const today = new Date(startOfDay(deps.now().getTime(), u?.tz ?? "UTC"));
  const since = sql`${today.toISOString()}::timestamptz`;
  const scope = and(
    eq(bots.userId, userId),
    botId === undefined ? eq(bots.mode, "live") : eq(orders.botId, botId),
  );
  const [c] = await deps.db
    .select({
      open: sql<number>`count(*) filter (where ${orders.status} in ('open', 'partially_filled'))::int`,
      partiallyFilled: sql<number>`count(*) filter (where ${orders.status} = 'partially_filled')::int`,
      filledToday: sql<number>`count(*) filter (where ${orders.status} = 'filled' and ${orders.submittedAt} >= ${since})::int`,
      rejectedToday: sql<number>`count(*) filter (where ${orders.status} = 'rejected' and ${orders.submittedAt} >= ${since})::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(orders)
    .innerJoin(bots, eq(bots.id, orders.botId))
    .where(scope);
  const [last] = await deps.db
    .select({ code: orders.rejectCode, message: orders.rejectMessage })
    .from(orders)
    .innerJoin(bots, eq(bots.id, orders.botId))
    .where(and(scope, eq(orders.status, "rejected"), sql`${orders.submittedAt} >= ${since}`))
    .orderBy(desc(orders.submittedAt))
    .limit(1);
  return {
    open: c?.open ?? 0,
    partiallyFilled: c?.partiallyFilled ?? 0,
    filledToday: c?.filledToday ?? 0,
    rejectedToday: c?.rejectedToday ?? 0,
    lastRejectCode: last?.code ?? null,
    lastRejectMessage: last?.message ?? null,
    total: c?.total ?? 0,
  };
}

/** Một trang lần khớp của bot, từ `fills` (dữ liệu SoDEX đã ghi), mới nhất trước. */
export async function listBotFills(
  deps: BotDeps,
  userId: string,
  botId: string,
  page: number,
): Promise<BotFillList> {
  await ownBot(deps.db, userId, botId);
  const [count] = await deps.db
    .select({ n: sql<number>`count(*)::int` })
    .from(fills)
    .innerJoin(orders, eq(orders.id, fills.orderId))
    .where(eq(orders.botId, botId));
  const rows = await deps.db
    .select({ f: fills, side: orders.side, reduceOnly: orders.reduceOnly })
    .from(fills)
    .innerJoin(orders, eq(orders.id, fills.orderId))
    .where(eq(orders.botId, botId))
    .orderBy(desc(fills.filledAt), desc(fills.sodexTradeId))
    .limit(BOT_FILLS_PAGE_SIZE)
    .offset((page - 1) * BOT_FILLS_PAGE_SIZE);
  const items = rows.map(({ f, side, reduceOnly }) => ({
    id: f.id,
    filledAt: iso(f.filledAt),
    side,
    price: f.price,
    size: f.size,
    value: dec(f.price).mul(f.size).toString(),
    fee: f.fee,
    liquidity: f.isMaker === null ? null : f.isMaker ? ("maker" as const) : ("taker" as const),
    close: reduceOnly,
  }));
  return { items, page, pageSize: BOT_FILLS_PAGE_SIZE, total: count?.n ?? 0 };
}

export async function listOrders(
  deps: BotDeps,
  userId: string,
  botId?: string,
): Promise<OrderView[]> {
  const rows = await deps.db
    .select({ o: orders })
    .from(orders)
    .innerJoin(bots, eq(bots.id, orders.botId))
    .where(
      and(
        eq(bots.userId, userId),
        // Execution & Orders chung chỉ có lệnh thật; lệnh mô phỏng chỉ hiện khi xem đúng bot paper (DEC-105).
        botId === undefined ? eq(bots.mode, "live") : eq(orders.botId, botId),
      ),
    )
    .orderBy(desc(orders.createdAt))
    .limit(200);
  return rows.map(({ o }) => ({
    id: o.id,
    botId: o.botId,
    clOrdId: o.clOrdId,
    market: o.market,
    side: o.side,
    type: o.type,
    price: o.price,
    size: o.size,
    filledSize: o.filledSize,
    status: o.status,
    rejectCode: o.rejectCode,
    rejectMessage: o.rejectMessage,
    submittedAt: o.submittedAt === null ? null : iso(o.submittedAt),
  }));
}
