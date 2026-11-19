import {
  loadSignalResearchArticles,
  loadSignalResearchArticleTrace,
  loadSignalResearchSummary,
  loadSignalResearchTrade,
  loadSignalResearchTrades,
  readOnlyTx,
  type Db,
} from "@drift/db";
import {
  AppError,
  ErrorCode,
  NEWS_LIMIT_DEFAULTS,
  researchArticlesPageSchema,
  researchArticlesQuerySchema,
  researchArticleTraceSchema,
  researchSummaryQuerySchema,
  researchSummarySchema,
  researchTradeDetailSchema,
  researchTradesPageSchema,
  researchTradesQuerySchema,
  type ResearchArticlesPage,
  type ResearchArticleTrace,
  type ResearchSummary,
  type ResearchTradeDetail,
  type ResearchTradesPage,
} from "@drift/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { parseOrThrow } from "../../lib/http";
import { requireAuth } from "../../plugins/session";
import { requireTeam } from "../account/team";

// Signal research, lane tin tức (#271): chỉ role team (401 chưa đăng nhập, 403 người ngoài team, kiểm trước khi parse
// tham số), chỉ đọc (transaction READ ONLY, statement timeout). Không bao giờ chạm SoDEX. no-store.

export interface SignalResearchDeps {
  db: Db;
  now: () => Date;
  /** Statement timeout (ms) của transaction; mặc định 10 s. */
  queryTimeoutMs?: number;
}

const FORBIDDEN = "Signal research is for the DeskLabs team only.";
const QUERY_TIMEOUT_MS = 10_000;
/** `tz` chỉ để web dùng chung key cache; API trả giờ UTC. */
const tzQuery = z.object({ tz: z.string().max(64).optional() });

/** Trần tổng thời gian của một request (giữa các câu; mỗi câu còn bị `statement_timeout`). */
const DEADLINE_MS = 20_000;

function tx<T>(deps: SignalResearchDeps, fn: Parameters<typeof readOnlyTx<T>>[2]): Promise<T> {
  return readOnlyTx(
    deps.db,
    { statementTimeoutMs: deps.queryTimeoutMs ?? QUERY_TIMEOUT_MS, deadlineMs: DEADLINE_MS },
    fn,
  );
}

export async function signalResearchSummary(
  deps: SignalResearchDeps,
  userId: string,
  query: unknown,
): Promise<ResearchSummary> {
  await requireTeam(deps.db, userId, FORBIDDEN);
  const { range } = parseOrThrow(researchSummaryQuerySchema, query);
  const out = await tx(deps, (q, check) =>
    loadSignalResearchSummary(
      q,
      deps.now(),
      {
        sosoMonthlyLimit: NEWS_LIMIT_DEFAULTS.sosoMonthlyLimit,
        claudeDailyInputBudget: NEWS_LIMIT_DEFAULTS.claudeDailyInputBudget,
      },
      check,
      range,
    ),
  );
  return researchSummarySchema.parse(out);
}

export async function signalResearchTrades(
  deps: SignalResearchDeps,
  userId: string,
  query: unknown,
): Promise<ResearchTradesPage> {
  await requireTeam(deps.db, userId, FORBIDDEN);
  const q = parseOrThrow(researchTradesQuerySchema, query);
  const out = await tx(deps, (t) => loadSignalResearchTrades(t, q, deps.now()));
  return researchTradesPageSchema.parse(out);
}

export async function signalResearchTrade(
  deps: SignalResearchDeps,
  userId: string,
  id: string,
  query: unknown,
): Promise<ResearchTradeDetail> {
  await requireTeam(deps.db, userId, FORBIDDEN);
  parseOrThrow(tzQuery, query);
  const out = await tx(deps, (t) => loadSignalResearchTrade(t, id, deps.now()));
  if (out === null) throw new AppError(ErrorCode.notFound, "Trade not found.");
  return researchTradeDetailSchema.parse(out);
}

/** Feed bài (#291): mọi bài SoSoValue của khoảng thời gian, kèm bước dừng / lý do / chi phí Claude. */
export async function signalResearchArticles(
  deps: SignalResearchDeps,
  userId: string,
  query: unknown,
): Promise<ResearchArticlesPage> {
  await requireTeam(deps.db, userId, FORBIDDEN);
  const q = parseOrThrow(researchArticlesQuerySchema, query);
  const out = await tx(deps, (t, check) => loadSignalResearchArticles(t, q, deps.now(), check));
  return researchArticlesPageSchema.parse(out);
}

/** Trace một bài qua 5 bước (#291). Bài không có / backlog / version khác → 404. */
export async function signalResearchArticleTrace(
  deps: SignalResearchDeps,
  userId: string,
  id: string,
  query: unknown,
): Promise<ResearchArticleTrace> {
  await requireTeam(deps.db, userId, FORBIDDEN);
  parseOrThrow(tzQuery, query);
  const out = await tx(deps, (t, check) => loadSignalResearchArticleTrace(t, id, check));
  if (out === null) throw new AppError(ErrorCode.notFound, "Article not found.");
  return researchArticleTraceSchema.parse(out);
}

export function registerSignalResearchRoutes(app: FastifyInstance, deps: SignalResearchDeps): void {
  const base = "/api/v1/admin/signal-research";
  app.get(`${base}/summary`, async (request, reply) => {
    void reply.header("cache-control", "no-store");
    return signalResearchSummary(deps, requireAuth(request).userId, request.query);
  });
  app.get(`${base}/trades`, async (request, reply) => {
    void reply.header("cache-control", "no-store");
    return signalResearchTrades(deps, requireAuth(request).userId, request.query);
  });
  app.get<{ Params: { id: string } }>(`${base}/trades/:id`, async (request, reply) => {
    void reply.header("cache-control", "no-store");
    return signalResearchTrade(deps, requireAuth(request).userId, request.params.id, request.query);
  });
  app.get(`${base}/articles`, async (request, reply) => {
    void reply.header("cache-control", "no-store");
    return signalResearchArticles(deps, requireAuth(request).userId, request.query);
  });
  app.get<{ Params: { id: string } }>(`${base}/articles/:id/trace`, async (request, reply) => {
    void reply.header("cache-control", "no-store");
    return signalResearchArticleTrace(
      deps,
      requireAuth(request).userId,
      request.params.id,
      request.query,
    );
  });
}
