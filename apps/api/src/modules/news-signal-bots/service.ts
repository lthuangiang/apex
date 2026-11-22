import { isDeepStrictEqual } from "node:util";

import {
  apiKeys,
  bots,
  botVersions,
  newsSignalCommands,
  newsSignalDeliveries,
  newsSignals,
  newsSignalTrades,
  signalBotVersions,
  sodexAccounts,
  versionHiddenFrom,
  type SignalVersionViewer,
} from "@drift/db";
import {
  AppError,
  assetAllowed,
  AssetKind,
  BotCommand,
  BotState,
  botVersionConfigSchema,
  CheckKey,
  dec,
  ErrorCode,
  isBuilderAccount,
  leverageSpecsOf,
  newsSignalConfigSchema,
  narrowsVersion,
  NEWS_BOTS_NOT_READY,
  ReasonCode,
  STOCK_MARKET_SET,
  Strategy,
  type BotSummary,
  type NewsBotCreateBody,
  type NewsBotVersionBody,
  type NewsBotVersionResult,
  NEWS_EDITABLE_FIELDS,
  type NewsBotSignal,
  type NewsCommand,
  type NewsTpslBody,
  type NewsTrade,
  type StartChecks,
  NEWS_SIGNAL_LEVERAGE,
  NEWS_SIGNAL_LEVERAGES,
} from "@drift/shared";
import { readDriftApproval } from "@drift/sodex";
import { and, desc, eq, gte, inArray, isNull, max } from "drizzle-orm";
import { getAddress } from "viem";

import { AuditAction, audit } from "../../lib/audit";
import { markSideEffect } from "../../lib/idempotency";
import { command, ownBot, saveVersion, summary, account, type BotDeps } from "../bots/service";
import { iso } from "../security/service";
import { verifyTwoFactor } from "../security/two-factor";

// Bot `news_signal` mainnet (#420, DEC-360, DEC-367). Chốt chặn tiền thật: `SIGNAL_NEWS_BOTS_ENABLED`
// (mặc định false) — tắt thì tạo bot, Start và Resume trả 409 `FEATURE_NOT_READY` cho mọi người (kể cả team), trước mọi
// thao tác ghi. Mỗi người chỉ thấy bot của mình: bot của người khác → 404 `BOT_NOT_FOUND`, kể cả với team. API không gọi
// SoDEX: Close now / Edit TP/SL chỉ ghi `news_signal_commands` (`queued`), engine xử lý.

export interface NewsBotDeps extends BotDeps {
  /** `SIGNAL_NEWS_BOTS_ENABLED`; đọc mỗi lần gọi. Thiếu = tắt. */
  newsBotsEnabled?: () => boolean;
}

/** Cờ tắt → 409 `FEATURE_NOT_READY`, không ghi gì. */
export function assertNewsBotsEnabled(deps: NewsBotDeps): void {
  if (deps.newsBotsEnabled?.() !== true)
    throw new AppError(ErrorCode.featureNotReady, NEWS_BOTS_NOT_READY);
}

/** Loại tài sản của market SoDEX: danh sách cổ phiếu (#309) là nguồn duy nhất; còn lại là crypto. */
const kindOf = (market: string) =>
  STOCK_MARKET_SET.has(market) ? AssetKind.stock : AssetKind.crypto;

/** Bot `news_signal` của chính người gọi; bot không có / của người khác / chiến lược khác → 404. */
export async function ownNewsBot(deps: Pick<BotDeps, "db">, userId: string, botId: string) {
  const b = await ownBot(deps.db, userId, botId);
  if (b.strategy !== Strategy.newsSignal)
    throw new AppError(ErrorCode.botNotFound, "Bot not found.");
  return b;
}

const LIVE_STATES = [
  BotState.starting,
  BotState.running,
  BotState.pausing,
  BotState.paused,
  BotState.resuming,
];

/**
 * Start-check `leverage_conflict` (DEC-58) của bot `news_signal`: account đã có bot thật khác (live / paused) đặt đòn bẩy
 * trên một market nằm trong phạm vi Markets của bot news → xung đột (chặn), báo bot và market đầu tiên. Bot `news_signal`
 * khác không tính (không giữ market cố định; engine chặn hai lệnh cùng account × market bằng `ACCOUNT_MARKET_BUSY`).
 */
export async function newsLeverageCheck(
  deps: Pick<BotDeps, "db">,
  sodexAccountId: string,
  config: unknown,
  selfId: string | null,
): Promise<StartChecks["checks"][number]> {
  const parsed = newsSignalConfigSchema.safeParse(config);
  const base = { leverage: "1", marginMode: "isolated" };
  if (!parsed.success)
    return { key: CheckKey.leverageConflict, ok: false, detail: "unavailable", data: base };
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
        eq(bots.sodexAccountId, sodexAccountId),
        // Bot paper không đặt đòn bẩy trên SoDEX (DEC-105).
        eq(bots.mode, "live"),
        inArray(bots.state, LIVE_STATES),
      ),
    );
  for (const o of others) {
    if (o.id === selfId || o.strategy === Strategy.newsSignal) continue;
    for (const spec of leverageSpecsOf(o.strategy, o.market, o.config)) {
      if (!assetAllowed(parsed.data.assets, spec.market, kindOf(spec.market))) continue;
      return {
        key: CheckKey.leverageConflict,
        ok: false,
        detail: "bot",
        data: {
          ...base,
          kind: "bot",
          market: spec.market,
          botName: o.name,
          currentLeverage: String(spec.leverage),
          currentMode: spec.marginMode,
        },
      };
    }
  }
  return {
    key: CheckKey.leverageConflict,
    ok: true,
    detail: "none",
    data: { ...base, kind: "none" },
  };
}

const invalid = (fieldErrors: Record<string, string[]>) =>
  new AppError(ErrorCode.validationFailed, "Invalid bot settings.", { fieldErrors });

/**
 * Tạo bot (draft) từ một version mà người gọi thấy được. Config đã qua `newsSignalConfigSchema` (size ≤ 200, đòn bẩy 1);
 * Markets chỉ được thu hẹp, Min level chỉ được nâng so với version (`narrowsVersion`). Gắn `bots.signal_version_id`.
 * Builder fee: mặc định của chiến lược (10), không lưu gì riêng.
 */
export async function createNewsBot(
  deps: NewsBotDeps,
  viewer: SignalVersionViewer,
  body: NewsBotCreateBody,
  ip: string | null,
): Promise<BotSummary> {
  assertNewsBotsEnabled(deps);
  const [v] = await deps.db
    .select({
      id: signalBotVersions.id,
      owner: signalBotVersions.ownerUserId,
      config: signalBotVersions.config,
    })
    .from(signalBotVersions)
    .where(eq(signalBotVersions.id, body.versionId))
    .limit(1);
  if (v === undefined || versionHiddenFrom(v.owner, viewer))
    throw new AppError(ErrorCode.notFound, "Version not found.");
  const source = botVersionConfigSchema.safeParse(v.config);
  if (!source.success) throw new AppError(ErrorCode.notFound, "Version not found.");
  assertNarrows(source.data, body.config);
  const a = await account(deps.db, viewer.userId);
  // DEC-58: bot thật khác của account đang dùng một market trong phạm vi của bot này → không tạo.
  const lev = await newsLeverageCheck(deps, a.id, body.config, null);
  if (!lev.ok)
    throw new AppError(
      ErrorCode.stateConflict,
      "Another bot on this account trades one of these markets.",
      {
        reason: "leverage_conflict",
        ...lev.data,
      },
    );
  const bot = await deps.db.transaction(async (tx) => {
    const [b] = await tx
      .insert(bots)
      .values({
        userId: viewer.userId,
        sodexAccountId: a.id,
        strategy: Strategy.newsSignal,
        // Bot nhiều market (theo tín hiệu): `bots.market` để trống, như mọi chỗ khác chỉ dùng cho bot một market.
        market: "",
        engine: "perps",
        name: body.name,
        state: BotState.draft,
        signalVersionId: v.id,
      })
      .returning();
    if (b === undefined) throw new AppError(ErrorCode.internal, "Could not create bot.");
    const [ver] = await tx
      .insert(botVersions)
      .values({
        botId: b.id,
        version: 1,
        config: body.config,
        paramSource: "manual",
        status: "active",
        appliedAt: new Date(),
      })
      .returning();
    const [updated] = await tx
      .update(bots)
      .set({ activeVersionId: ver?.id ?? null })
      .where(eq(bots.id, b.id))
      .returning();
    markSideEffect();
    return updated ?? b;
  });
  await audit(deps.db, {
    userId: viewer.userId,
    action: AuditAction.botCreated,
    target: bot.id,
    metadata: { strategy: Strategy.newsSignal, signalVersionId: v.id },
    ip,
  });
  return summary(bot, 1, null, body.config);
}

/** Bot `news_signal` của người gọi (chưa archive), mới nhất trước. */
export async function listNewsBots(
  deps: Pick<BotDeps, "db">,
  userId: string,
): Promise<BotSummary[]> {
  const rows = await deps.db
    .select({ bot: bots, version: botVersions.version, config: botVersions.config })
    .from(bots)
    .leftJoin(botVersions, eq(botVersions.id, bots.activeVersionId))
    .where(
      and(eq(bots.userId, userId), eq(bots.strategy, Strategy.newsSignal), isNull(bots.archivedAt)),
    )
    .orderBy(desc(bots.createdAt));
  return rows.map((r) => summary(r.bot, r.version, null, r.config));
}

async function activeConfig(deps: Pick<BotDeps, "db">, b: typeof bots.$inferSelect) {
  const [v] = await deps.db
    .select({ config: botVersions.config })
    .from(botVersions)
    .where(eq(botVersions.id, b.activeVersionId ?? ""))
    .limit(1);
  return (v?.config ?? {}) as Record<string, unknown>;
}

/**
 * Kiểm tra trước Start của bot `news_signal` (mockup "Start bot from a version"): API key dùng được, builder fee đã
 * approve, margin isolated đủ cho size × Max open trades. Không có kiểm tra giá / min size theo market: bot nhiều market,
 * min size được kiểm ở từng tín hiệu (`BELOW_MIN_ORDER_SIZE`).
 */
export async function newsStartChecks(
  deps: NewsBotDeps,
  userId: string,
  botId: string,
): Promise<StartChecks> {
  const b = await ownNewsBot(deps, userId, botId);
  const [a] = await deps.db
    .select()
    .from(sodexAccounts)
    .where(eq(sodexAccounts.id, b.sodexAccountId))
    .limit(1);
  if (a === undefined) throw new AppError(ErrorCode.botNotFound, "Bot not found.");
  const config = await activeConfig(deps, b);
  const [key] = await deps.db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.sodexAccountId, a.id), eq(apiKeys.status, "active")))
    .orderBy(desc(apiKeys.createdAt))
    .limit(1);
  const now = deps.now().getTime();
  const keyUsable =
    key === undefined || deps.verifyApiKey === undefined ? "ok" : await deps.verifyApiKey(key.id);
  const keyOk = key !== undefined && key.expiresAt.getTime() > now && keyUsable === "ok";
  const address = getAddress(a.address);
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
  const { available, needed, ok: balanceOk } = await newsMarginCheck(deps, address, config);
  const leverage = await newsLeverageCheck(deps, a.id, config, b.id);
  const checks: StartChecks["checks"] = [
    {
      key: CheckKey.apiKey,
      ok: keyOk,
      detail: key === undefined ? "missing" : keyUsable === "ok" ? null : keyUsable,
    },
    { key: CheckKey.builderFee, ok: feeOk, detail: exempt ? "exempt" : null },
    {
      key: CheckKey.balance,
      ok: balanceOk,
      detail: available,
      data: { available, needed, marginMode: "isolated" },
    },
    leverage,
  ];
  return { checks, allOk: checks.every((c) => c.ok) };
}

/**
 * Margin isolated cần cho config của bot news = giá trị vị thế mỗi lệnh × số lệnh mở tối đa ÷ đòn bẩy (#458; bot cũ không có
 * trường là 1×), so với margin còn dùng được của account trên SoDEX. Không đọc được thì `available` null, `ok` false.
 */
async function newsMarginCheck(
  deps: Pick<BotDeps, "rest">,
  address: `0x${string}`,
  config: Record<string, unknown>,
): Promise<{ available: string | null; needed: string; ok: boolean }> {
  const size = typeof config.sizeUsdc === "string" ? config.sizeUsdc : "0";
  const maxOpen = typeof config.maxOpenTrades === "number" ? config.maxOpenTrades : 1;
  const leverageX =
    typeof config.leverage === "number" &&
    (NEWS_SIGNAL_LEVERAGES as readonly number[]).includes(config.leverage)
      ? config.leverage
      : NEWS_SIGNAL_LEVERAGE;
  const needed = dec(size).mul(maxOpen).div(leverageX).toString();
  let available: string | null = null;
  try {
    available = (await deps.rest.getPerpsAccountState(address)).ami;
  } catch {
    available = null;
  }
  return { available, needed, ok: available !== null && dec(available).gte(needed) };
}

/**
 * Sửa bot `news_signal` thành version mới (#469, DEC-TBD-news-version-apply). Thứ tự: cờ → quyền Signal Research (route) →
 * chủ bot → 2FA như Start → trạng thái → schema (size ≤ 200, đòn bẩy 1 / 5 / 10 / 20) → chỉ thu hẹp version gốc → chỉ 5 field
 * sửa được (field khác 422 `locked`) → `leverage_conflict` (DEC-58) → ghi version (đang chờ áp thì 409 `applying`). Bot
 * đang chạy / pause: version `pending`, engine áp (không huỷ lệnh nào) rồi mới `active` ("Applying v{n}…", quy tắc 1.6).
 * Bot draft / stopped: `active` ngay (DEC-131). Kèm kiểm margin theo config mới: thiếu chỉ cảnh báo, không chặn lưu.
 */
export async function newNewsVersion(
  deps: NewsBotDeps,
  userId: string,
  botId: string,
  body: NewsBotVersionBody,
  ip: string | null,
  sessionId?: string,
): Promise<NewsBotVersionResult> {
  assertNewsBotsEnabled(deps);
  // Quyền Signal Research (team hoặc cờ) kiểm ở route, trước Idempotency-Key, như Start.
  const b = await ownNewsBot(deps, userId, botId);
  await verifyTwoFactor(
    deps,
    userId,
    body.twoFactorCode,
    ip,
    sessionId === undefined ? {} : { sessionId },
  );
  assertEditable(b.state);
  const config = body.config;
  if (b.signalVersionId === null) throw new AppError(ErrorCode.botNotFound, "Bot not found.");
  const [v] = await deps.db
    .select({ config: signalBotVersions.config })
    .from(signalBotVersions)
    .where(eq(signalBotVersions.id, b.signalVersionId))
    .limit(1);
  const source = botVersionConfigSchema.safeParse(v?.config);
  if (!source.success) throw new AppError(ErrorCode.notFound, "Version not found.");
  assertNarrows(source.data, config);
  // Chỉ 5 field sửa được; còn lại phải đúng như version đang chạy (so sau khi parse, như lúc lưu jsonb).
  const current = newsSignalConfigSchema.safeParse(await activeConfig(deps, b));
  if (!current.success) throw new AppError(ErrorCode.botStateConflict, "Bot can't be edited.");
  const editable = new Set<string>(NEWS_EDITABLE_FIELDS);
  const locked: Record<string, string[]> = {};
  // So như sau khi lưu jsonb (thứ tự khoá không tính, field `undefined` bị bỏ).
  const norm = (x: unknown): unknown => (x === undefined ? null : JSON.parse(JSON.stringify(x)));
  for (const key of new Set([...Object.keys(current.data), ...Object.keys(config)]))
    if (
      !editable.has(key) &&
      !isDeepStrictEqual(
        norm((current.data as Record<string, unknown>)[key]),
        norm((config as Record<string, unknown>)[key]),
      )
    )
      locked[key] = ["locked"];
  if (Object.keys(locked).length > 0) throw invalid(locked);
  const lev = await newsLeverageCheck(deps, b.sodexAccountId, config, b.id);
  if (!lev.ok)
    throw new AppError(
      ErrorCode.stateConflict,
      "Another bot on this account trades one of these markets.",
      { reason: "leverage_conflict", ...lev.data },
    );
  const saved = await saveVersion(
    deps,
    botId,
    config as unknown as Record<string, unknown>,
    { paramSource: "manual" },
    async (tx, row) => {
      // Dưới khoá dòng bot: trạng thái đọc lại, và version đang chờ áp (Applying) thì không sửa tiếp.
      assertEditable(row.state);
      const [pending] = await tx
        .select({ version: botVersions.version })
        .from(botVersions)
        .where(and(eq(botVersions.botId, botId), eq(botVersions.status, "pending")))
        .limit(1);
      if (pending !== undefined)
        throw new AppError(ErrorCode.botStateConflict, "The previous edit is still applying.", {
          reason: "applying",
          version: pending.version,
        });
    },
  );
  const [a] = await deps.db
    .select({ address: sodexAccounts.address })
    .from(sodexAccounts)
    .where(eq(sodexAccounts.id, b.sodexAccountId))
    .limit(1);
  const balance =
    a === undefined
      ? { available: null, needed: "0", ok: false }
      : await newsMarginCheck(
          deps,
          getAddress(a.address),
          config as unknown as Record<string, unknown>,
        );
  return {
    version: saved.version,
    status: saved.status === "active" ? "active" : "pending",
    balance,
  };
}

/** Sửa được khi bot không đang chuyển trạng thái (Starting / Pausing / Resuming / Stopping) và chưa archive. */
function assertEditable(state: BotState): void {
  if (
    state !== BotState.running &&
    state !== BotState.paused &&
    state !== BotState.draft &&
    state !== BotState.stopped
  )
    throw new AppError(ErrorCode.botStateConflict, "Bot can't be edited in this state.", {
      state,
    });
}

/** Markets chỉ thu hẹp, Min level chỉ nâng so với version gốc (DEC-360); lỗi theo field như lúc tạo. */
function assertNarrows(
  source: Parameters<typeof narrowsVersion>[0],
  config: Parameters<typeof narrowsVersion>[1],
): void {
  if (narrowsVersion(source, config, kindOf)) return;
  const fieldErrors: Record<string, string[]> = {};
  if (!narrowsVersion(source, { ...config, assets: source.assets }, kindOf))
    fieldErrors.minLevel = ["Can only be raised from the version."];
  if (!narrowsVersion(source, { ...config, minLevel: source.minLevel }, kindOf))
    fieldErrors.assets = ["Can only narrow the version’s markets."];
  throw invalid(fieldErrors);
}

/**
 * Start bot `news_signal`: cờ → quyền (team hoặc `users.signal_research`) → 2FA → xác nhận → kiểm tra → state machine.
 * Cờ tắt thì dừng ngay ở bước đầu (409), chưa đọc gì khác.
 */
export async function startNewsBot(
  deps: NewsBotDeps,
  userId: string,
  botId: string,
  input: { twoFactorCode?: string | undefined; acknowledged?: boolean | undefined },
  ip: string | null,
  sessionId?: string,
): Promise<BotSummary> {
  assertNewsBotsEnabled(deps);
  await ownNewsBot(deps, userId, botId);
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
  const checks = await newsStartChecks(deps, userId, botId);
  if (!checks.allOk) {
    const failed = checks.checks.filter((c) => !c.ok).map((c) => c.key);
    if (failed.includes(CheckKey.builderFee))
      throw new AppError(ErrorCode.builderFeeNotApproved, "Builder fee is not approved.", {
        failed,
      });
    throw new AppError(ErrorCode.validationFailed, "Start checks failed.", { failed });
  }
  const b = await command(deps, userId, botId, BotCommand.start, { reasonCode: null });
  await audit(deps.db, { userId, action: AuditAction.botStarted, target: botId, ip });
  return summary(b, null, null);
}

/** Resume bot `news_signal`: cờ trước, rồi chỉ khi lý do pause (builder fee / key) đã hết. */
export async function resumeNewsBot(
  deps: NewsBotDeps,
  userId: string,
  botId: string,
): Promise<BotSummary> {
  assertNewsBotsEnabled(deps);
  const b = await ownNewsBot(deps, userId, botId);
  if (
    b.reasonCode === ReasonCode.builderFeeRevoked ||
    b.reasonCode === ReasonCode.apiKeyExpired ||
    b.reasonCode === ReasonCode.apiKeyUnusable
  ) {
    const checks = await newsStartChecks(deps, userId, botId);
    const need =
      b.reasonCode === ReasonCode.builderFeeRevoked ? CheckKey.builderFee : CheckKey.apiKey;
    if (checks.checks.find((c) => c.key === need)?.ok !== true)
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

/* ---------------------------------------------------------------- Lệnh (Mainnet trades) và command */

type TradeRow = typeof newsSignalTrades.$inferSelect;
type CommandRow = typeof newsSignalCommands.$inferSelect;
const PENDING = ["queued", "applying", "unknown"] as const;

const commandView = (c: CommandRow): NewsCommand => ({
  id: c.id,
  tradeId: c.tradeId,
  kind: c.kind === "close" ? "close" : "edit_tpsl",
  seq: c.seq,
  tp: c.tp === null ? null : dec(c.tp).toFixed(),
  sl: c.sl === null ? null : dec(c.sl).toFixed(),
  status:
    (["queued", "applying", "applied", "rejected", "unknown"] as const).find(
      (s) => s === c.status,
    ) ?? "unknown",
  createdAt: iso(c.createdAt),
});

const decOut = (v: string | null) => (v === null ? null : dec(v).toFixed());

function tradeView(t: TradeRow, pending: CommandRow | undefined): NewsTrade {
  return {
    id: t.id,
    signalId: t.signalId,
    market: t.market,
    side: t.side === "short" ? "short" : "long",
    status: t.status === "closed" ? "closed" : t.status === "closing" ? "closing" : "open",
    sizeUsdc: dec(t.sizeUsdc).toFixed(),
    leverage: t.leverage,
    qty: dec(t.qty).toFixed(),
    entryAvgPrice: decOut(t.entryAvgPrice),
    tpPrice: decOut(t.tpPrice),
    slPrice: decOut(t.slPrice),
    maxHoldUntil: t.maxHoldOffAt === null ? iso(t.maxHoldUntil) : null,
    openedAt: iso(t.openedAt),
    closedAt: t.closedAt === null ? null : iso(t.closedAt),
    closeReason: t.closeReason,
    exitAvgPrice: decOut(t.exitAvgPrice),
    pendingCommand: pending === undefined ? null : commandView(pending),
  };
}

/** Mainnet trades của bot (mới nhất trước, tối đa 200), kèm command chưa xong của từng lệnh. */
export async function listNewsTrades(
  deps: Pick<BotDeps, "db">,
  userId: string,
  botId: string,
): Promise<NewsTrade[]> {
  await ownNewsBot(deps, userId, botId);
  const trades = await deps.db
    .select()
    .from(newsSignalTrades)
    .where(eq(newsSignalTrades.botId, botId))
    .orderBy(desc(newsSignalTrades.openedAt))
    .limit(200);
  if (trades.length === 0) return [];
  const pending = await deps.db
    .select()
    .from(newsSignalCommands)
    .where(
      and(
        inArray(
          newsSignalCommands.tradeId,
          trades.map((t) => t.id),
        ),
        inArray(newsSignalCommands.status, [...PENDING]),
      ),
    )
    .orderBy(desc(newsSignalCommands.seq));
  const byTrade = new Map<string, CommandRow>();
  for (const c of pending) if (!byTrade.has(c.tradeId)) byTrade.set(c.tradeId, c);
  return trades.map((t) => tradeView(t, byTrade.get(t.id)));
}

/** Tín hiệu dùng chung trong 24 giờ (mới nhất trước, tối đa 100) và kết quả trên bot này. */
export async function listNewsBotSignals(
  deps: Pick<BotDeps, "db" | "now">,
  userId: string,
  botId: string,
): Promise<NewsBotSignal[]> {
  await ownNewsBot(deps, userId, botId);
  const since = new Date(deps.now().getTime() - 24 * 60 * 60_000);
  const rows = await deps.db
    .select({ s: newsSignals, d: newsSignalDeliveries })
    .from(newsSignals)
    .leftJoin(
      newsSignalDeliveries,
      and(eq(newsSignalDeliveries.signalId, newsSignals.id), eq(newsSignalDeliveries.botId, botId)),
    )
    .where(gte(newsSignals.decidedAt, since))
    .orderBy(desc(newsSignals.decidedAt))
    .limit(100);
  return rows.map(({ s, d }) => ({
    id: s.id,
    market: s.market,
    catalyst: s.catalyst,
    side: s.side === "short" ? "short" : "long",
    level: s.level === "high" ? "high" : s.level === "medium" ? "medium" : "low",
    decidedAt: iso(s.decidedAt),
    expiresAt: iso(s.expiresAt),
    outcome: d === null ? null : d.outcome === "accepted" ? "accepted" : "dropped",
    reason: d?.reason ?? null,
  }));
}

/**
 * Close now / Edit TP/SL: ghi một dòng `news_signal_commands` (`queued`, `seq` tăng theo lệnh) dưới khoá dòng trade. Trade
 * phải thuộc bot của người gọi (join `bots.user_id`), đang `open`, và chưa có command chưa xong. Edit kiểm giá dương và
 * thứ tự TP / SL theo chiều lệnh (dùng giá hiện tại cho phần giữ nguyên).
 */
export async function queueNewsCommand(
  deps: Pick<BotDeps, "db">,
  userId: string,
  botId: string,
  tradeId: string,
  kind: "close" | "edit_tpsl",
  body: NewsTpslBody | null,
  ip: string | null,
): Promise<NewsCommand> {
  // Bot của người khác → 404 `BOT_NOT_FOUND` (như mọi route bot); trade không thuộc bot → 404 `NOT_FOUND`.
  await ownNewsBot(deps, userId, botId);
  const created = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select({ trade: newsSignalTrades })
      .from(newsSignalTrades)
      .innerJoin(bots, eq(bots.id, newsSignalTrades.botId))
      .where(
        and(
          eq(newsSignalTrades.id, tradeId),
          eq(newsSignalTrades.botId, botId),
          eq(bots.userId, userId),
          eq(bots.strategy, Strategy.newsSignal),
        ),
      )
      .for("update", { of: newsSignalTrades });
    if (row === undefined) throw new AppError(ErrorCode.notFound, "Trade not found.");
    const t = row.trade;
    if (t.status !== "open")
      throw new AppError(ErrorCode.stateConflict, "This trade is not open.", {
        reason: "trade_not_open",
        status: t.status,
      });
    let tp: string | null = null;
    let sl: string | null = null;
    if (kind === "edit_tpsl") {
      tp = body?.tp ?? null;
      sl = body?.sl ?? null;
      const tpAfter = tp ?? t.tpPrice;
      const slAfter = sl ?? t.slPrice;
      if (tpAfter !== null && slAfter !== null) {
        const ok = t.side === "long" ? dec(slAfter).lt(tpAfter) : dec(slAfter).gt(tpAfter);
        if (!ok)
          throw new AppError(ErrorCode.validationFailed, "Invalid take profit or stop loss.", {
            fieldErrors: {
              [sl === null ? "tp" : "sl"]: [
                t.side === "long"
                  ? "Stop loss must be below take profit."
                  : "Stop loss must be above take profit.",
              ],
            },
          });
      }
    }
    const [open] = await tx
      .select({ id: newsSignalCommands.id })
      .from(newsSignalCommands)
      .where(
        and(eq(newsSignalCommands.tradeId, t.id), inArray(newsSignalCommands.status, [...PENDING])),
      )
      .limit(1);
    if (open !== undefined)
      throw new AppError(
        ErrorCode.stateConflict,
        "Another change to this trade is still running.",
        {
          reason: "command_pending",
        },
      );
    const [last] = await tx
      .select({ seq: max(newsSignalCommands.seq) })
      .from(newsSignalCommands)
      .where(eq(newsSignalCommands.tradeId, t.id));
    const [c] = await tx
      .insert(newsSignalCommands)
      .values({
        tradeId: t.id,
        kind,
        seq: (last?.seq ?? 0) + 1,
        tp,
        sl,
        status: "queued",
        createdBy: userId,
      })
      .returning();
    if (c === undefined) throw new AppError(ErrorCode.internal, "Could not save the change.");
    markSideEffect();
    return c;
  });
  await audit(deps.db, {
    userId,
    action: kind === "close" ? AuditAction.newsTradeClose : AuditAction.newsTradeEditTpsl,
    target: tradeId,
    metadata: { botId, commandId: created.id, seq: created.seq },
    ip,
  });
  return commandView(created);
}
