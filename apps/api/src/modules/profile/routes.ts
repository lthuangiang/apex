import {
  bots,
  fills,
  goals,
  notificationSettings,
  orders,
  sessions,
  sodexAccounts,
  users,
} from "@drift/db";
import {
  AppError,
  BotState,
  deleteAccountBodySchema,
  ErrorCode,
  preferencesBodySchema,
} from "@drift/shared";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { AuditAction, audit } from "../../lib/audit";
import { parseOrThrow } from "../../lib/http";
import { idempotent } from "../../lib/idempotency";
import { clearSessionCookie, requireAuth } from "../../plugins/session";
import { verifyTwoFactor, type TwoFactorDeps } from "../security/two-factor";

// Settings › Trading defaults / Profile (SCREENS.md mục 8.5, DEC-42): tuỳ chọn hiển thị, xuất CSV, xoá tài khoản.
// Xoá tài khoản cần 2FA, mọi bot đã dừng và SoDEX đã Disconnect (key của DRIFT đã bị xoá phía SoDEX).

const BLOCKING: readonly BotState[] = [
  BotState.starting,
  BotState.running,
  BotState.pausing,
  BotState.paused,
  BotState.resuming,
  BotState.stopping,
];

function csvCell(v: string | number | boolean | Date | bigint | null | undefined): string {
  const s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function registerProfileRoutes(
  app: FastifyInstance,
  deps: TwoFactorDeps & { cookieSecure: boolean },
): void {
  const { db } = deps;

  app.put("/api/v1/me/preferences", async (request, reply) => {
    const auth = requireAuth(request);
    const body = parseOrThrow(preferencesBodySchema, request.body);
    if (body.timezone !== undefined) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: body.timezone });
      } catch {
        throw new AppError(ErrorCode.validationFailed, "Unknown time zone.", {
          fieldErrors: { timezone: ["Unknown time zone."] },
        });
      }
    }
    if (
      body.defaultMaxLossPct != null &&
      !(Number(body.defaultMaxLossPct) > 0 && Number(body.defaultMaxLossPct) <= 100)
    ) {
      throw new AppError(ErrorCode.validationFailed, "Allowed 0–100%.", {
        fieldErrors: { defaultMaxLossPct: ["Allowed 0–100%."] },
      });
    }
    return idempotent(db, request, reply, auth.userId, deps.now(), async () => {
      await db
        .update(users)
        .set({
          ...(body.displayName === undefined ? {} : { displayName: body.displayName }),
          ...(body.timezone === undefined ? {} : { timezone: body.timezone }),
          ...(body.numberFormat === undefined ? {} : { numberFormat: body.numberFormat }),
          ...(body.defaultMaxLossPct === undefined
            ? {}
            : { defaultMaxLossPct: body.defaultMaxLossPct }),
        })
        .where(eq(users.id, auth.userId));
      return { status: 204, body: null };
    });
  });

  /** CSV mọi lệnh DRIFT đã gửi cho người dùng, kèm từng fill (phí đã gồm builder fee). */
  app.get("/api/v1/account/export.csv", async (request, reply) => {
    const auth = requireAuth(request);
    const rows = await db
      .select({
        submittedAt: orders.submittedAt,
        bot: bots.name,
        market: orders.market,
        side: orders.side,
        type: orders.type,
        price: orders.price,
        size: orders.size,
        status: orders.status,
        clOrdId: orders.clOrdId,
        fillAt: fills.filledAt,
        fillPrice: fills.price,
        fillSize: fills.size,
        fee: fills.fee,
        builderFee: fills.builderFee,
      })
      .from(orders)
      .innerJoin(bots, eq(bots.id, orders.botId))
      .leftJoin(fills, eq(fills.orderId, orders.id))
      .where(eq(bots.userId, auth.userId))
      .orderBy(asc(orders.submittedAt));
    const header = [
      "submitted_at",
      "bot",
      "market",
      "side",
      "type",
      "price",
      "size",
      "status",
      "client_order_id",
      "fill_at",
      "fill_price",
      "fill_size",
      "fee",
      "builder_fee",
    ];
    const lines = [header.join(","), ...rows.map((r) => Object.values(r).map(csvCell).join(","))];
    return reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", 'attachment; filename="drift-orders.csv"')
      .send(`${lines.join("\n")}\n`);
  });

  app.delete("/api/v1/account", async (request, reply) => {
    const auth = requireAuth(request);
    const { twoFactorCode } = parseOrThrow(deleteAccountBodySchema, request.body ?? {});
    await verifyTwoFactor(deps, auth.userId, twoFactorCode, request.ip);
    const [active] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(bots)
      .where(and(eq(bots.userId, auth.userId), inArray(bots.state, [...BLOCKING])));
    if ((active?.n ?? 0) > 0)
      throw new AppError(ErrorCode.stateConflict, "Stop every bot before deleting your account.", {
        reason: "bots_active",
      });
    const [linked] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(sodexAccounts)
      .where(
        and(
          eq(sodexAccounts.userId, auth.userId),
          inArray(sodexAccounts.status, ["connecting", "connected"]),
        ),
      );
    if ((linked?.n ?? 0) > 0)
      throw new AppError(
        ErrorCode.stateConflict,
        "Disconnect SoDEX before deleting your account.",
        { reason: "sodex_connected" },
      );
    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({
          email: `deleted-${auth.userId}@deleted.invalid`,
          displayName: null,
          walletAddress: null,
          twofaEnabled: false,
          twofaSecret: null,
          twofaPendingSecret: null,
          deletedAt: deps.now(),
        })
        .where(eq(users.id, auth.userId));
      await tx
        .update(sessions)
        .set({ revokedAt: deps.now() })
        .where(and(eq(sessions.userId, auth.userId), isNull(sessions.revokedAt)));
      await tx.delete(goals).where(eq(goals.userId, auth.userId));
      await tx.delete(notificationSettings).where(eq(notificationSettings.userId, auth.userId));
    });
    await audit(db, {
      userId: auth.userId,
      action: AuditAction.accountDeleted,
      target: auth.userId,
      ip: request.ip,
    });
    clearSessionCookie(reply, deps.cookieSecure);
    return reply.status(204).send();
  });
}
