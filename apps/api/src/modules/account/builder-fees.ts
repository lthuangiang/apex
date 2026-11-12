import { botEvents, bots, userBuilderFees, users, type Db } from "@drift/db";
import {
  AppError,
  BOT_STRATEGIES,
  builderFeeRateFor,
  builderFeeRateOf,
  ENGINE_ACTIVE_STATES,
  ErrorCode,
  feeRateToPercent,
  type AdminBuilderFee,
  type BuilderFeeOverrides,
  type BuilderFeeRow,
} from "@drift/shared";
import { and, eq, inArray, isNull } from "drizzle-orm";

import { AuditAction, audit } from "../../lib/audit";

import { requireTeam } from "./team";

// Builder fee riêng theo user × chiến lược (DEC-159). Team đặt 0–0.01% ở Users; lệnh mới của user dùng ngay mức này
// (engine đọc lại mỗi vòng). Không có dòng = mặc định `builderFeeRateOf`.

/** Mức team đã đặt riêng cho user. */
export async function builderFeeOverrides(db: Db, userId: string): Promise<BuilderFeeOverrides> {
  const rows = await db
    .select({ strategy: userBuilderFees.strategy, rate: userBuilderFees.rate })
    .from(userBuilderFees)
    .where(eq(userBuilderFees.userId, userId));
  return Object.fromEntries(rows.map((r) => [r.strategy, r.rate]));
}

/** Builder fee hiệu lực của user cho mọi chiến lược (GET /features). */
export async function builderFeesOf(db: Db, userId: string): Promise<Record<string, number>> {
  const own = await builderFeeOverrides(db, userId);
  return Object.fromEntries(BOT_STRATEGIES.map((s) => [s, builderFeeRateFor(s, own)]));
}

/** Bảng builder fee của user cho trang Users của team. */
export async function builderFeeRows(db: Db, userId: string): Promise<BuilderFeeRow[]> {
  const own = await builderFeeOverrides(db, userId);
  return BOT_STRATEGIES.map((strategy) => ({
    strategy,
    defaultRate: builderFeeRateOf(strategy),
    rate: builderFeeRateFor(strategy, own),
    custom: own[strategy] !== undefined,
  }));
}

const pct = (rate: number) => `${feeRateToPercent(rate).toString()}%`;

/**
 * Team đặt (hoặc bỏ, `rate = null`) builder fee riêng cho một chiến lược của user. Bot đang chạy của chiến lược đó
 * nhận một dòng Decisions để user biết mức mới; lệnh đã gửi giữ mức cũ.
 */
export async function setBuilderFee(
  deps: { db: Db; now: () => Date },
  actorId: string,
  targetId: string,
  strategy: (typeof BOT_STRATEGIES)[number],
  rate: number | null,
  ip: string | null,
): Promise<AdminBuilderFee> {
  await requireTeam(deps.db, actorId, "Users is for the DeskLabs team only.");
  const now = deps.now();
  const notified = await deps.db.transaction(async (tx) => {
    const [u] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, targetId), isNull(users.deletedAt)))
      .limit(1);
    if (u === undefined) throw new AppError(ErrorCode.notFound, "User not found.");
    const before = builderFeeRateFor(strategy, await builderFeeOverrides(tx, targetId));
    if (rate === null)
      await tx
        .delete(userBuilderFees)
        .where(and(eq(userBuilderFees.userId, targetId), eq(userBuilderFees.strategy, strategy)));
    else
      await tx
        .insert(userBuilderFees)
        .values({ userId: targetId, strategy, rate, updatedBy: actorId })
        .onConflictDoUpdate({
          target: [userBuilderFees.userId, userBuilderFees.strategy],
          set: { rate, updatedBy: actorId, updatedAt: now },
        });
    const after = rate ?? builderFeeRateOf(strategy);
    let count = 0;
    if (after !== before) {
      const running = await tx
        .select({ id: bots.id })
        .from(bots)
        .where(
          and(
            eq(bots.userId, targetId),
            eq(bots.strategy, strategy),
            inArray(bots.state, [...ENGINE_ACTIVE_STATES]),
          ),
        );
      if (running.length > 0)
        await tx.insert(botEvents).values(
          running.map((b) => ({
            botId: b.id,
            type: "decision",
            decision: "Builder fee changed",
            why: `The team set your builder fee for this strategy to ${pct(after)} (was ${pct(before)}). New orders use it.`,
            occurredAt: now,
          })),
        );
      count = running.length;
    }
    await audit(tx, {
      userId: actorId,
      action: AuditAction.builderFeeChanged,
      target: targetId,
      metadata: { strategy, before, after, custom: rate !== null, notified: count },
      ip,
    });
    return count;
  });
  return { builderFees: await builderFeeRows(deps.db, targetId), notified };
}
