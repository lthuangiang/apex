import {
  apiKeys,
  botEvents,
  botRuntime,
  bots,
  botVersions,
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
  ErrorCode,
  isBuilderAccount,
  leverageConflict,
  leverageSpecOf,
  ReasonCode,
  Strategy,
  type BotDetail,
  type BotSummary,
  type CreateBotBody,
  type OrderView,
  type StartChecks,
} from "@drift/shared";
import { readDriftApproval, type SodexRestClient } from "@drift/sodex";
import {
  costPerMillion,
  costUsed,
  leverageCapIssue,
  meetsMinSize,
  minSizeDetail,
  requirementOf,
  STRATEGIES,
  type MarketRules,
  type VolumeMakerState,
} from "@drift/strategies";
import { and, desc, eq, inArray, isNull, max, sql } from "drizzle-orm";
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
  /** Giá gần nhất do marketdata ghi (Redis `md:last:<market>`). */
  lastPrice: (market: string) => Promise<{ price: string; at: number } | null>;
  /** Giá gần nhất của nhiều market một lần (MGET); market thiếu giá thì không có key. */
  prices: (markets: readonly string[]) => Promise<Record<string, string>>;
  /** VOLUME_MAKER_ENABLED: tắt thì Volume Maker như không tồn tại (VOLUME_MAKER.md mục 17.5). */
  volumeMakerEnabled?: boolean;
  /** Signer giải mã thử key (UI_REVIEW H1). Không có (test cũ) thì chỉ xét trạng thái và hạn trong DB. */
  verifyApiKey?: (id: string) => Promise<"ok" | "unusable" | "unavailable">;
}

export function assertStrategyAvailable(
  strategy: string,
  volumeMakerEnabled: boolean | undefined,
): void {
  if (strategy === Strategy.volumeMaker && volumeMakerEnabled !== true)
    throw new AppError(ErrorCode.notFound, "Strategy not available.");
}

function parseConfig(strategy: string, config: unknown): Record<string, unknown> {
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
  return parsed.data as Record<string, unknown>;
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
  const market =
    strategy === Strategy.fundingArb && typeof config.perpMarket === "string"
      ? config.perpMarket
      : config.market;
  const symbol = (await deps.rest.getPerpsSymbols()).find((s) => s.name === market);
  if (symbol === undefined) {
    throw new AppError(ErrorCode.validationFailed, "Invalid bot settings.", {
      fieldErrors: { leverage: ["Market not found on SoDEX."] },
    });
  }
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

async function account(db: Db, userId: string) {
  const [a] = await db
    .select()
    .from(sodexAccounts)
    .where(and(eq(sodexAccounts.userId, userId), eq(sodexAccounts.status, "connected")))
    .orderBy(desc(sodexAccounts.createdAt))
    .limit(1);
  if (a === undefined) throw new AppError(ErrorCode.notFound, "No SoDEX account connected.");
  return a;
}

async function ownBot(db: Db, userId: string, botId: string) {
  const [b] = await db
    .select()
    .from(bots)
    .where(and(eq(bots.id, botId), eq(bots.userId, userId)))
    .limit(1);
  if (b === undefined) throw new AppError(ErrorCode.botNotFound, "Bot not found.");
  return b;
}

function netOf(state: unknown): string | null {
  const l = (state as { ledger?: { realized: string; fees: string; funding: string } } | null)
    ?.ledger;
  if (l === undefined) return null;
  return dec(l.realized).sub(l.fees).sub(l.funding).toString();
}

/** Vốn của bot theo cấu hình (cột Capital ở Strategy Lab); TWAP / Volume Maker không có vốn cố định. */
function capitalOf(strategy: string, config: unknown): string | null {
  if (config === null || typeof config !== "object") return null;
  try {
    const c = requirementOf(strategy, config as Record<string, unknown>).capital;
    return dec(c).gt(0) ? c : null;
  } catch {
    return null;
  }
}

function summary(
  b: typeof bots.$inferSelect,
  version: number | null,
  state: unknown,
  config: unknown = null,
  fills = 0,
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
    netPnl: netOf(state),
    capital: capitalOf(b.strategy, config),
    fills,
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
  assertStrategyAvailable(body.strategy, deps.volumeMakerEnabled);
  const a = await account(deps.db, userId);
  const config = parseConfig(body.strategy, body.config);
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

export async function listBots(deps: BotDeps, userId: string): Promise<BotSummary[]> {
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
    .where(and(eq(bots.userId, userId), sql`${bots.state} <> 'archived'`))
    .orderBy(desc(bots.updatedAt));
  return rows.map((r) => summary(r.bot, r.version, r.state, r.config, r.fills));
}

function vmStats(strategy: string, config: unknown, state: unknown): BotDetail["volumeMaker"] {
  if (strategy !== Strategy.volumeMaker || state === null || config === null) return null;
  const c = config as { volumeTarget: string; costBudget: string };
  const st = state as VolumeMakerState;
  return {
    volume: st.volume,
    volumeTarget: c.volumeTarget,
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
  const [open] = await deps.db
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .where(and(eq(orders.botId, botId), inArray(orders.status, ["open", "partially_filled"])));
  const [filled] = await deps.db
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .where(and(eq(orders.botId, botId), inArray(orders.status, ["filled", "partially_filled"])));
  const active = versions.find((v) => v.id === b.activeVersionId);
  return {
    // Cùng công thức vốn với danh sách (`GET /bots`), để hai endpoint thống nhất (UI_REVIEW F7).
    bot: summary(
      b,
      active?.version ?? null,
      runtime?.state ?? null,
      active?.config ?? null,
      filled?.n ?? 0,
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
    volumeMaker: vmStats(b.strategy, active?.config ?? null, runtime?.state ?? null),
  };
}

async function rulesFor(deps: BotDeps, market: string): Promise<MarketRules | undefined> {
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
  assertStrategyAvailable(body.strategy, deps.volumeMakerEnabled);
  const a = await account(deps.db, userId);
  const config = parseConfig(body.strategy, body.config);
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
  const [user] = await deps.db
    .select({ twofa: users.twofaEnabled })
    .from(users)
    .where(eq(users.id, userId))
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
  const exempt = isBuilderAccount(a.sodexAccountId, deps.builderId);
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
  const spec = leverageSpecOf(b.strategy, req.market, config);
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
      .flatMap((o) => {
        const os = leverageSpecOf(o.strategy, o.market, o.config);
        return os === null ? [] : [{ name: o.name, spec: os }];
      });
    if (perpsState === null) {
      leverageCheck = { key: CheckKey.leverageConflict, ok: false, detail: "unavailable" };
    } else {
      const c = leverageConflict(spec, perpsState, otherSpecs);
      const base = {
        kind: c.kind,
        market: spec.market,
        leverage: String(spec.leverage),
        marginMode: spec.marginMode,
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
  const fresh = last !== null && now - last.at <= PRICE_FRESH_MS;
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
    { key: CheckKey.twoFactor, ok: user?.twofa === true, detail: null },
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
): Promise<BotSummary> {
  await verifyTwoFactor(deps, userId, input.twoFactorCode, ip);
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
  twoFactorCode: string | undefined,
  ip: string | null,
): Promise<BotSummary> {
  await verifyTwoFactor(deps, userId, twoFactorCode, ip);
  const b = await command(deps, userId, botId, BotCommand.stop);
  await audit(deps.db, { userId, action: AuditAction.botStopped, target: botId, ip });
  return summary(b, null, null);
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
  if (b.state !== BotState.running && b.state !== BotState.paused && b.state !== BotState.draft) {
    throw new AppError(ErrorCode.botStateConflict, "Bot can't be edited in this state.", {
      state: b.state,
    });
  }
  const config = parseConfig(b.strategy, input.config);
  // Khoá: strategy, market (SCREENS.md mục 8.4).
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
    const draft = b.state === BotState.draft;
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

export async function listOrders(
  deps: BotDeps,
  userId: string,
  botId?: string,
): Promise<OrderView[]> {
  const rows = await deps.db
    .select({ o: orders })
    .from(orders)
    .innerJoin(bots, eq(bots.id, orders.botId))
    .where(and(eq(bots.userId, userId), botId === undefined ? sql`true` : eq(orders.botId, botId)))
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
    submittedAt: o.submittedAt === null ? null : iso(o.submittedAt),
  }));
}
