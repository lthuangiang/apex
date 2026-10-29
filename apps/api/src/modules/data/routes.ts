import { accountAnalyses, imports, outbox, sodexAccounts, type Db } from "@drift/db";
import { AppError, ErrorCode, type AnalysisView, type ImportView } from "@drift/shared";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { idempotent } from "../../lib/idempotency";
import { requireAuth } from "../../plugins/session";
import { iso } from "../security/service";

// Onboarding bước 3–4: bắt đầu import (ghi `imports` + outbox `jobs.import` cùng transaction,
// ARCHITECTURE.md mục 3.3.4) và đọc kết quả. Việc import chạy ở `jobs`.

async function connectedAccount(db: Db, userId: string) {
  const [account] = await db
    .select()
    .from(sodexAccounts)
    .where(and(eq(sodexAccounts.userId, userId), eq(sodexAccounts.status, "connected")))
    .orderBy(desc(sodexAccounts.createdAt))
    .limit(1);
  if (account === undefined) throw new AppError(ErrorCode.notFound, "No SoDEX account connected.");
  return account;
}

function toView(row: typeof imports.$inferSelect): ImportView {
  return {
    id: row.id,
    status: row.status,
    progress: row.progress as ImportView["progress"],
    coverage: row.coverage as ImportView["coverage"],
    startedAt: row.startedAt === null ? null : iso(row.startedAt),
    finishedAt: row.finishedAt === null ? null : iso(row.finishedAt),
  };
}

export function registerDataRoutes(app: FastifyInstance, deps: { db: Db; now: () => Date }): void {
  const { db } = deps;

  app.post("/api/v1/imports", async (request, reply) => {
    const auth = requireAuth(request);
    const account = await connectedAccount(db, auth.userId);
    return idempotent(db, request, reply, auth.userId, deps.now(), async () => {
      const created = await db.transaction(async (tx) => {
        // Đang có import chạy thì trả lại nó, không tạo thêm.
        const [active] = await tx
          .select()
          .from(imports)
          .where(and(eq(imports.sodexAccountId, account.id), eq(imports.status, "running")))
          .limit(1);
        if (active !== undefined) return active;
        const [row] = await tx
          .insert(imports)
          .values({ sodexAccountId: account.id, status: "queued" })
          .returning();
        if (row === undefined) throw new AppError(ErrorCode.internal, "Could not create import.");
        await tx.insert(outbox).values({ topic: "jobs.import", payload: { importId: row.id } });
        return row;
      });
      return { status: 202, body: { import: toView(created) } };
    });
  });

  app.get("/api/v1/imports/latest", async (request) => {
    const auth = requireAuth(request);
    const account = await connectedAccount(db, auth.userId);
    const [row] = await db
      .select()
      .from(imports)
      .where(eq(imports.sodexAccountId, account.id))
      .orderBy(desc(imports.createdAt))
      .limit(1);
    return { import: row === undefined ? null : toView(row) };
  });

  app.get("/api/v1/analysis/latest", async (request): Promise<AnalysisView> => {
    const auth = requireAuth(request);
    const account = await connectedAccount(db, auth.userId);
    const [row] = await db
      .select()
      .from(accountAnalyses)
      .where(eq(accountAnalyses.sodexAccountId, account.id))
      .orderBy(desc(accountAnalyses.computedAt))
      .limit(1);
    return {
      analysis:
        row === undefined
          ? null
          : {
              id: row.id,
              computedAt: iso(row.computedAt),
              metrics: row.metrics as NonNullable<AnalysisView["analysis"]>["metrics"],
            },
    };
  });
}
