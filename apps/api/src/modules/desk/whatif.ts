import {
  botReviews,
  bots,
  botVersions,
  deskApplies,
  deskItems,
  deskWhatifs,
  outbox,
} from "@drift/db";
import {
  AppError,
  applyPatch,
  botReviewResultSchema,
  ErrorCode,
  optionsFor,
  pickOption,
  Strategy,
  WHATIF_CONFIG,
  type NeedsYouRule,
  type RiskInput,
  type WhatIfOptionResult,
  type WhatIfView,
} from "@drift/shared";
import { and, desc, eq, gte, inArray } from "drizzle-orm";

import { newVersion, type BotDeps } from "../bots/service";

import { stopCheckOf } from "./needs-you";

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

function view(w: typeof deskWhatifs.$inferSelect, rule: NeedsYouRule): WhatIfView {
  const options = w.options as WhatIfOptionResult[];
  return {
    id: w.id,
    itemId: w.itemId,
    botId: w.botId,
    rule,
    status: w.status,
    source: w.source,
    windowFrom: w.windowFrom.toISOString(),
    windowTo: w.windowTo.toISOString(),
    botVersion: w.botVersion,
    options,
    pick: w.status === "done" ? pickOption(rule, options) : null,
    error: w.error,
  };
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
  if (recent !== undefined) return view(recent, item.rule);

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
  return view(w, item.rule);
}

export async function whatifView(deps: BotDeps, userId: string, id: string): Promise<WhatIfView> {
  const [row] = await deps.db
    .select({ w: deskWhatifs, rule: deskItems.rule })
    .from(deskWhatifs)
    .innerJoin(deskItems, eq(deskItems.id, deskWhatifs.itemId))
    .where(and(eq(deskWhatifs.id, id), eq(deskWhatifs.userId, userId)))
    .limit(1);
  if (row === undefined) throw new AppError(ErrorCode.notFound, "Comparison not found.");
  return view(row.w, row.rule);
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
