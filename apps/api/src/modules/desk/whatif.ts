import {
  botReviews,
  bots,
  botVersions,
  deskApplies,
  deskItems,
  deskWhatifs,
  goals,
  outbox,
} from "@drift/db";
import {
  AppError,
  applyPatch,
  botReviewResultSchema,
  ErrorCode,
  goalGauge,
  optionsFor,
  pickOption,
  Strategy,
  WHATIF_CONFIG,
  dec,
  type ConfigPatch,
  type DeskHomeView,
  type MarginTier,
  type NeedsYouRule,
  type RiskInput,
  type WhatIfOptionResult,
  type WhatIfView,
} from "@drift/shared";
import { and, desc, eq, gte, inArray } from "drizzle-orm";

import { riskStatusOf } from "../account/service";
import { newVersion, type BotDeps } from "../bots/service";

import { needsYou, stopCheckOf, type NeedsYouDeps } from "./needs-you";

// AI Desk B+ M2 (DEC-166): so sánh 2–3 phương án cho một việc "Needs you" và Apply thành version mới "AI suggested".
// API sinh phương án (patch config), worker `backtest` tính kết quả 7 ngày (replay lệnh thật / backtest nến). Apply đi
// qua luồng sửa bot hiện có (`newVersion`): bot đang chạy → version `pending`, engine áp ("Applying vN…").

/** Job còn mới thì dùng lại (bấm Compare nhiều lần không xếp thêm việc cho worker). */
const REUSE_MS = 60 * 60_000;

const STOP_FIELD: Partial<Record<string, RiskInput["stopField"]>> = {
  [Strategy.futuresDca]: "stopLossPct",
  [Strategy.adaptiveDca]: "hardStopLossPct",
  [Strategy.futuresGrid]: null,
};

async function ownItem(deps: BotDeps, userId: string, itemId: string) {
  const [item] = await deps.db
    .select()
    .from(deskItems)
    .where(and(eq(deskItems.id, itemId), eq(deskItems.userId, userId)))
    .limit(1);
  if (item?.resolvedAt !== null) throw new AppError(ErrorCode.notFound, "Item not found.");
  return item;
}

async function activeVersion(deps: BotDeps, botId: string) {
  const [row] = await deps.db
    .select({ b: bots, config: botVersions.config, version: botVersions.version })
    .from(bots)
    .innerJoin(botVersions, eq(botVersions.id, bots.activeVersionId))
    .where(eq(bots.id, botId))
    .limit(1);
  if (row === undefined) throw new AppError(ErrorCode.botNotFound, "Bot not found.");
  return row;
}

/** Đầu vào phương án quy tắc 1: khoảng stop / đòn bẩy hiện tại + bậc margin SoDEX. */
async function riskInput(
  deps: BotDeps,
  strategy: string,
  market: string,
  config: Record<string, unknown>,
): Promise<RiskInput | null> {
  const tiers = (await deps.rest.getPerpsSymbols()).find((s) => s.name === market)?.marginTiers;
  const s = stopCheckOf(strategy, config, tiers);
  if (s === null) return null;
  const isFarm = strategy === Strategy.volumeFarm;
  const stopField: RiskInput["stopField"] = isFarm
    ? typeof config.slPct === "string"
      ? "slPct"
      : "slMarginPct"
    : (STOP_FIELD[strategy] ?? null);
  return {
    strategy,
    leverage: s.leverage,
    stopDistance: s.stopDistance,
    side: s.side,
    notional: s.notional,
    tiers: s.tiers,
    stopField,
    slMarginPct: isFarm && typeof config.slMarginPct === "string" ? config.slMarginPct : null,
  };
}

/** Bộ tốt hơn của Review this run (chỉ `strong`, chưa áp dụng, DEC-142). */
async function reviewBest(deps: BotDeps, botId: string) {
  const [r] = await deps.db
    .select()
    .from(botReviews)
    .where(eq(botReviews.botId, botId))
    .orderBy(desc(botReviews.createdAt))
    .limit(1);
  if (r?.result == null || r.appliedVersion !== null) return null;
  const parsed = botReviewResultSchema.safeParse(r.result);
  if (!parsed.success || parsed.data.status !== "done") return null;
  const suggestion = parsed.data.suggestion ?? (parsed.data.recommended ? "strong" : "none");
  return suggestion === "strong" ? parsed.data.best.params : null;
}

/** Bot + config của đúng version đã so + bậc margin SoDEX: để ghi phương án bằng lời (đòn bẩy, stop % giá). */
interface ViewContext {
  bot: WhatIfView["bot"];
  config: Record<string, unknown> | null;
  tiers: readonly MarginTier[] | undefined;
}

async function contextOf(deps: BotDeps, botId: string, version: number): Promise<ViewContext> {
  const [row] = await deps.db
    .select({ b: bots, config: botVersions.config })
    .from(bots)
    .leftJoin(botVersions, and(eq(botVersions.botId, bots.id), eq(botVersions.version, version)))
    .where(eq(bots.id, botId))
    .limit(1);
  if (row === undefined) throw new AppError(ErrorCode.botNotFound, "Bot not found.");
  const tiers = (await deps.rest.getPerpsSymbols()).find(
    (s) => s.name === row.b.market,
  )?.marginTiers;
  return {
    bot: { name: row.b.name, strategy: row.b.strategy, market: row.b.market, state: row.b.state },
    config: (row.config as Record<string, unknown> | null) ?? null,
    tiers,
  };
}

function displayOf(ctx: ViewContext, patch: ConfigPatch): WhatIfView["options"][number]["display"] {
  if (ctx.config === null) return null;
  const config = applyPatch(ctx.config, patch);
  const s = stopCheckOf(ctx.bot.strategy, config, ctx.tiers);
  const leverage = typeof config.leverage === "number" ? config.leverage : null;
  return {
    leverage,
    stopPct: s === null ? null : dec(s.stopDistance).mul(100).toDecimalPlaces(2).toString(),
  };
}

function view(
  w: typeof deskWhatifs.$inferSelect,
  rule: NeedsYouRule,
  ctx: ViewContext,
): WhatIfView {
  const options = w.options as WhatIfOptionResult[];
  return {
    id: w.id,
    itemId: w.itemId,
    botId: w.botId,
    bot: ctx.bot,
    rule,
    status: w.status,
    source: w.source,
    windowFrom: w.windowFrom.toISOString(),
    windowTo: w.windowTo.toISOString(),
    botVersion: w.botVersion,
    options: options.map((o) => ({ ...o, display: displayOf(ctx, o.patch) })),
    pick: w.status === "done" ? pickOption(rule, options) : null,
    error: w.error,
  };
}

const viewOf = async (deps: BotDeps, w: typeof deskWhatifs.$inferSelect, rule: NeedsYouRule) =>
  view(w, rule, await contextOf(deps, w.botId, w.botVersion));

/** Thẻ Mục tiêu (DEC-TBD-desk-goal-record): goals + drawdown Risk Center; chưa có goals → null. */
export async function goalOf(deps: BotDeps, userId: string): Promise<DeskHomeView["goal"]> {
  const [g] = await deps.db.select().from(goals).where(eq(goals.userId, userId)).limit(1);
  const risk = g === undefined ? null : await riskStatusOf(deps, userId);
  return g === undefined
    ? null
    : {
        goal: g.goal,
        ...goalGauge(
          { capital: g.capital, maxDrop: g.maxDrop },
          risk === null ? null : { peakEquity: risk.status.peakEquity, equity: risk.status.equity },
        ),
      };
}

/**
 * Trang chủ B+ (M3): việc "Needs you" kèm so sánh mới nhất cho đúng việc + version bot + fingerprint (job còn trong
 * `REUSE_MS`); không có thì `whatif = null` và web bấm Compare thay user (chỉ tính, không đổi bot).
 */
export async function deskHome(
  deps: NeedsYouDeps & BotDeps,
  userId: string,
): Promise<DeskHomeView> {
  const base = await needsYou(deps, userId);
  const now = deps.now().getTime();
  const items = await Promise.all(
    base.items.map(async (item) => {
      const [row] = await deps.db
        .select({
          w: deskWhatifs,
          fingerprint: deskItems.fingerprint,
          version: botVersions.version,
        })
        .from(deskWhatifs)
        .innerJoin(deskItems, eq(deskItems.id, deskWhatifs.itemId))
        .innerJoin(bots, eq(bots.id, deskWhatifs.botId))
        .innerJoin(botVersions, eq(botVersions.id, bots.activeVersionId))
        .where(
          and(
            eq(deskWhatifs.itemId, item.id),
            gte(deskWhatifs.createdAt, new Date(now - REUSE_MS)),
          ),
        )
        .orderBy(desc(deskWhatifs.createdAt))
        .limit(1);
      const age = row === undefined ? 0 : now - row.w.createdAt.getTime();
      const fresh =
        row !== undefined &&
        row.w.botVersion === row.version &&
        row.w.itemFingerprint === row.fingerprint &&
        // `queued` lâu (tin mất) hoặc `failed` đã đủ lâu: trả null để web bấm Compare, startWhatif xếp job mới.
        !(row.w.status === "queued" && age > WHATIF_CONFIG.queuedReuseMs) &&
        !(row.w.status === "failed" && age > WHATIF_CONFIG.failedRetryMs);
      return { ...item, whatif: fresh ? await viewOf(deps, row.w, item.rule) : null };
    }),
  );
  const goal = await goalOf(deps, userId);
  return { ...base, items, goal };
}

/** Compare: dùng lại job còn mới cho đúng việc + version, không thì sinh phương án và xếp job cho worker. */
export async function startWhatif(
  deps: BotDeps,
  userId: string,
  itemId: string,
): Promise<WhatIfView> {
  const item = await ownItem(deps, userId, itemId);
  const bot = await activeVersion(deps, item.botId);
  const now = deps.now();
  const [recent] = await deps.db
    .select()
    .from(deskWhatifs)
    .where(
      and(
        eq(deskWhatifs.itemId, item.id),
        eq(deskWhatifs.botVersion, bot.version),
        eq(deskWhatifs.itemFingerprint, item.fingerprint),
        inArray(deskWhatifs.status, ["queued", "running", "done"]),
        gte(deskWhatifs.createdAt, new Date(now.getTime() - REUSE_MS)),
      ),
    )
    .orderBy(desc(deskWhatifs.createdAt))
    .limit(1);
  const lost =
    recent?.status === "queued" &&
    now.getTime() - recent.createdAt.getTime() > WHATIF_CONFIG.queuedReuseMs;
  if (recent !== undefined && !lost) return viewOf(deps, recent, item.rule);
  if (recent !== undefined)
    await deps.db
      .update(deskWhatifs)
      .set({ status: "failed", error: "stale", finishedAt: now })
      .where(and(eq(deskWhatifs.id, recent.id), eq(deskWhatifs.status, "queued")));

  const config = bot.config as Record<string, unknown>;
  const options = optionsFor({
    rule: item.rule,
    risk:
      item.rule === "liquidation_before_stop"
        ? await riskInput(deps, bot.b.strategy, bot.b.market, config)
        : null,
    reviewBest:
      item.rule === "better_review" || item.rule === "max_loss_hit"
        ? await reviewBest(deps, bot.b.id)
        : null,
  }).map((o): WhatIfOptionResult => ({ ...o, outcome: null, unavailable: null }));
  const to = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const from = new Date(to.getTime() - WHATIF_CONFIG.windowMs);
  // Không có cách sửa cụ thể: không xếp job (what-if chỉ khi có phương án, AI_DESK_BPLUS_PROMPT mục 3).
  const noFix = options.length < 2;
  const w = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(deskWhatifs)
      .values({
        itemId: item.id,
        userId,
        botId: bot.b.id,
        botVersion: bot.version,
        itemFingerprint: item.fingerprint,
        status: noFix ? "unavailable" : "queued",
        options,
        windowFrom: from,
        windowTo: to,
        error: noFix ? "no_fix" : null,
        finishedAt: noFix ? now : null,
      })
      .returning();
    if (row === undefined)
      throw new AppError(ErrorCode.internal, "Could not start the comparison.");
    if (!noFix)
      await tx.insert(outbox).values({ topic: "backtest.run", payload: { whatifId: row.id } });
    return row;
  });
  return viewOf(deps, w, item.rule);
}

export async function whatifView(deps: BotDeps, userId: string, id: string): Promise<WhatIfView> {
  const [row] = await deps.db
    .select({ w: deskWhatifs, rule: deskItems.rule })
    .from(deskWhatifs)
    .innerJoin(deskItems, eq(deskItems.id, deskWhatifs.itemId))
    .where(and(eq(deskWhatifs.id, id), eq(deskWhatifs.userId, userId)))
    .limit(1);
  if (row === undefined) throw new AppError(ErrorCode.notFound, "Comparison not found.");
  return viewOf(deps, row.w, row.rule);
}

/**
 * Apply: version mới từ config hiện tại + patch của phương án, nguồn `ai` và một dòng `desk_applies` ("AI suggested",
 * nguồn cho thành tích sau 7 ngày). Chỉ khi so sánh đã xong, phương án có kết quả, và bot vẫn ở đúng version đã so.
 */
export async function applyWhatif(
  deps: BotDeps,
  userId: string,
  id: string,
  option: "lower_leverage" | "tighter_stop" | "review_settings",
) {
  const [row] = await deps.db
    .select({ w: deskWhatifs, rule: deskItems.rule })
    .from(deskWhatifs)
    .innerJoin(deskItems, eq(deskItems.id, deskWhatifs.itemId))
    .where(and(eq(deskWhatifs.id, id), eq(deskWhatifs.userId, userId)))
    .limit(1);
  if (row === undefined) throw new AppError(ErrorCode.notFound, "Comparison not found.");
  if (row.w.status !== "done")
    throw new AppError(ErrorCode.stateConflict, "The comparison isn't ready.", {
      reason: "not_done",
    });
  const chosen = (row.w.options as WhatIfOptionResult[]).find((o) => o.key === option);
  if (chosen?.outcome == null)
    throw new AppError(ErrorCode.validationFailed, "This option has no result to apply.", {
      reason: "no_result",
    });
  const applied = () =>
    new AppError(ErrorCode.stateConflict, "This comparison was already applied.", {
      reason: "applied",
    });
  const [already] = await deps.db
    .select({ id: deskApplies.id })
    .from(deskApplies)
    .where(eq(deskApplies.whatifId, id))
    .limit(1);
  if (already !== undefined) throw applied();
  const bot = await activeVersion(deps, row.w.botId);
  if (bot.version !== row.w.botVersion)
    throw new AppError(
      ErrorCode.stateConflict,
      "Settings changed since this comparison. Compare again.",
      {
        reason: "version_changed",
      },
    );
  const baseline = bot.config as Record<string, unknown>;
  // Giữ chỗ trước khi tạo version: hai lần bấm Apply cùng lúc chỉ một lần qua được unique index `desk_applies_whatif`.
  const [held] = await deps.db
    .insert(deskApplies)
    .values({
      whatifId: id,
      userId,
      botId: bot.b.id,
      rule: row.rule,
      option,
      fromVersion: bot.version,
      toVersion: null,
      baselineConfig: baseline,
      appliedAt: deps.now(),
    })
    .onConflictDoNothing({ target: deskApplies.whatifId })
    .returning({ id: deskApplies.id });
  if (held === undefined) throw applied();
  let v: Awaited<ReturnType<typeof newVersion>>;
  try {
    v = await newVersion(deps, userId, bot.b.id, {
      config: applyPatch(baseline, chosen.patch),
      paramSource: "ai",
    });
  } catch (err) {
    await deps.db.delete(deskApplies).where(eq(deskApplies.id, held.id));
    throw err;
  }
  await deps.db
    .update(deskApplies)
    .set({ toVersion: v.version, updatedAt: deps.now() })
    .where(eq(deskApplies.id, held.id));
  return {
    botId: bot.b.id,
    version: v.version,
    status: v.status === "active" ? "active" : "pending",
    option,
  } as const;
}
