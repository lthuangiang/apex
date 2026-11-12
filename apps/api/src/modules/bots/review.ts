import { botReviews, botVersions, outbox } from "@drift/db";
import {
  AppError,
  botReviewResultSchema,
  ErrorCode,
  REVIEW_STRATEGIES,
  type BotReviewView,
} from "@drift/shared";
import { and, desc, eq, inArray } from "drizzle-orm";

import { iso } from "../security/service";

import { newVersion, ownBot, type BotDeps } from "./service";

// Review sau khi chạy của Volume Builder (DEC-131): api xếp job vào `backtest.run` (payload `reviewId`), worker
// backtest tính, trang bot đọc kết quả. "Use these settings" tạo version mới nguồn `ai` từ đề xuất.

/** Job chưa xong sau ngần này thì cho chạy lại (worker có thể đã chết giữa chừng). */
const STALE_MS = 10 * 60_000;

function view(r: typeof botReviews.$inferSelect): BotReviewView {
  const result = r.result === null ? null : botReviewResultSchema.safeParse(r.result);
  return {
    id: r.id,
    status: r.status,
    error: r.error,
    result: result?.success === true ? result.data : null,
    appliedVersion: r.appliedVersion,
    createdAt: iso(r.createdAt),
    finishedAt: r.finishedAt === null ? null : iso(r.finishedAt),
  };
}

async function reviewable(deps: BotDeps, userId: string, botId: string) {
  const b = await ownBot(deps.db, userId, botId);
  if (!(REVIEW_STRATEGIES as readonly string[]).includes(b.strategy))
    throw new AppError(ErrorCode.validationFailed, "Reviews are only for Volume Builder bots.");
  return b;
}

export async function latestReview(
  deps: BotDeps,
  userId: string,
  botId: string,
): Promise<BotReviewView | null> {
  await reviewable(deps, userId, botId);
  const [row] = await deps.db
    .select()
    .from(botReviews)
    .where(eq(botReviews.botId, botId))
    .orderBy(desc(botReviews.createdAt))
    .limit(1);
  return row === undefined ? null : view(row);
}

export async function startReview(
  deps: BotDeps,
  userId: string,
  botId: string,
): Promise<BotReviewView> {
  await reviewable(deps, userId, botId);
  const [pending] = await deps.db
    .select()
    .from(botReviews)
    .where(and(eq(botReviews.botId, botId), inArray(botReviews.status, ["queued", "running"])))
    .orderBy(desc(botReviews.createdAt))
    .limit(1);
  if (pending !== undefined && deps.now().getTime() - pending.createdAt.getTime() < STALE_MS)
    return view(pending);
  return deps.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(botReviews)
      .values({ botId, userId, status: "queued" })
      .returning();
    if (row === undefined) throw new AppError(ErrorCode.internal, "Could not queue the review.");
    await tx.insert(outbox).values({ topic: "backtest.run", payload: { reviewId: row.id } });
    return view(row);
  });
}

export async function applyReview(
  deps: BotDeps,
  userId: string,
  botId: string,
  reviewId: string,
): Promise<{ version: number; status: string }> {
  const b = await reviewable(deps, userId, botId);
  const [row] = await deps.db
    .select()
    .from(botReviews)
    .where(and(eq(botReviews.id, reviewId), eq(botReviews.botId, botId)))
    .limit(1);
  const parsed = row?.result == null ? null : botReviewResultSchema.safeParse(row.result);
  const result = parsed?.success === true ? parsed.data : null;
  // Đề xuất `weak` (ít dữ liệu, DEC-134) cũng áp dụng được: UI đã cảnh báo trước khi người dùng bấm.
  const level =
    result?.status === "done"
      ? (result.suggestion ?? (result.recommended ? "strong" : "none"))
      : "none";
  if (row === undefined || result?.status !== "done" || level === "none")
    throw new AppError(ErrorCode.validationFailed, "This review has no settings to apply.");
  if (row.appliedVersion !== null)
    throw new AppError(ErrorCode.botStateConflict, "These settings were already applied.", {
      version: row.appliedVersion,
    });
  const [active] = await deps.db
    .select({ config: botVersions.config })
    .from(botVersions)
    .where(eq(botVersions.id, b.activeVersionId ?? ""))
    .limit(1);
  const base = { ...((active?.config ?? {}) as Record<string, unknown>) };
  // Tham số theo dạng mới: bỏ SL % giá (DEC-126) và early profit USDC cố định (DEC-130) của config cũ.
  delete base.slPct;
  delete base.earlyProfitUsd;
  const p = result.best.params;
  const config = {
    ...base,
    earlyProfitFees: String(p.earlyProfitFees),
    earlyExitSecs: p.earlyExitSecs,
    minHoldSecs: p.minHoldSecs,
    maxHoldSecs: p.maxHoldSecs,
    slMarginPct: String(p.slMarginPct),
  };
  const created = await newVersion(deps, userId, botId, { config, paramSource: "ai" });
  await deps.db
    .update(botReviews)
    .set({ appliedVersion: created.version })
    .where(eq(botReviews.id, reviewId));
  return created;
}
