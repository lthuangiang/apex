import {
  loadNextLabelArticle,
  loadSignalClassifiers,
  loadSignalResearchArticles,
  loadSignalResearchArticleTrace,
  loadSignalResearchSummary,
  loadSignalResearchTrade,
  loadSignalResearchTrades,
  readOnlyTx,
  saveSignalClassificationLabel,
  type Db,
  type LastPrices,
} from "@drift/db";
import {
  AppError,
  ErrorCode,
  NEWS_LIMIT_DEFAULTS,
  researchArticlesPageSchema,
  researchArticlesQuerySchema,
  researchArticleTraceSchema,
  researchClassifiersSchema,
  researchLabelBodySchema,
  researchLabelNextSchema,
  researchLabelSavedSchema,
  researchSummaryQuerySchema,
  researchSummarySchema,
  researchTradeDetailSchema,
  researchTradesPageSchema,
  researchTradesQuerySchema,
  type ResearchArticlesPage,
  type ResearchArticleTrace,
  type ResearchClassifiers,
  type ResearchLabelNext,
  type ResearchLabelSaved,
  type ResearchSummary,
  type ResearchTradeDetail,
  type ResearchTradesPage,
} from "@drift/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { parseOrThrow } from "../../lib/http";
import { idempotent } from "../../lib/idempotency";
import { requireAuth } from "../../plugins/session";
import { requireTeam } from "../account/team";

// Signal research, lane tin tức (#271): chỉ role team (401 chưa đăng nhập, 403 người ngoài team, kiểm trước khi parse
// tham số), chỉ đọc (transaction READ ONLY, statement timeout). Không bao giờ chạm SoDEX (giá của lệnh đang mở chỉ đọc
// cache `md:last:*`). no-store. Ngoại lệ ghi duy nhất (#304): `PUT /articles/:id/label` lưu nhãn phân loại của người gọi,
// bắt buộc Idempotency-Key, ghi audit.

export interface SignalResearchDeps {
  db: Db;
  now: () => Date;
  /** Statement timeout (ms) của transaction; mặc định 10 s. */
  queryTimeoutMs?: number;
  /**
   * Giá SoDEX gần nhất (Redis `md:last:*`) cho lãi / lỗ chưa chốt của lệnh giấy đang mở (#297). Chỉ đọc cache, không gọi
   * SoDEX. Không truyền → không có lãi / lỗ chưa chốt.
   */
  prices?: LastPrices;
}

const FORBIDDEN = "Signal research is for the DeskLabs team only.";
const QUERY_TIMEOUT_MS = 10_000;
/** `tz` chỉ để web dùng chung key cache; API trả giờ UTC. */
const tzQuery = z.object({ tz: z.string().max(64).optional() });
const articleParams = z.object({ id: z.string().min(1).max(200) });

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
      deps.prices,
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
  const out = await tx(deps, (t) => loadSignalResearchTrades(t, q, deps.now(), deps.prices));
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
  const out = await tx(deps, (t) => loadSignalResearchTrade(t, id, deps.now(), deps.prices));
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
  const out = await tx(deps, (t, check) => loadSignalResearchArticleTrace(t, id, check, userId));
  if (out === null) throw new AppError(ErrorCode.notFound, "Article not found.");
  return researchArticleTraceSchema.parse(out);
}

/**
 * Bài ngẫu nhiên để gắn nhãn (#304): trong các bài classifier hiện tại gọi là tín hiệu mà người gọi chưa gắn nhãn. Không
 * có bất kỳ trường kết quả nào (schema strict), để kết quả lệnh không ảnh hưởng nhãn.
 */
export async function signalResearchLabelNext(
  deps: SignalResearchDeps,
  userId: string,
  query: unknown,
): Promise<ResearchLabelNext> {
  await requireTeam(deps.db, userId, FORBIDDEN);
  parseOrThrow(tzQuery, query);
  const out = await tx(deps, (t) => loadNextLabelArticle(t, userId));
  return researchLabelNextSchema.parse(out);
}

/** Lưu (upsert) nhãn của người gọi cho một bài tín hiệu; trả nhãn + kết quả lệnh của bài (đã lưu nên không còn ẩn). */
export async function signalResearchSaveLabel(
  deps: SignalResearchDeps,
  userId: string,
  params: unknown,
  body: unknown,
  ip: string | null,
): Promise<ResearchLabelSaved> {
  const { id } = parseOrThrow(articleParams, params);
  const b = parseOrThrow(researchLabelBodySchema, body);
  const out = await saveSignalClassificationLabel(deps.db, {
    articleId: id,
    userId,
    verdict: b.verdict,
    reason: b.reason ?? null,
    note: b.note ?? null,
    ip,
    now: deps.now(),
  });
  return researchLabelSavedSchema.parse(out);
}

/** Chất lượng classifier theo version prompt: số nhãn, precision, khoảng Wilson 95%, cổng, lỗi hay gặp. */
export async function signalResearchClassifiers(
  deps: SignalResearchDeps,
  userId: string,
  query: unknown,
): Promise<ResearchClassifiers> {
  await requireTeam(deps.db, userId, FORBIDDEN);
  parseOrThrow(tzQuery, query);
  const out = await tx(deps, (t, check) => loadSignalClassifiers(t, check));
  return researchClassifiersSchema.parse(out);
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
  app.get(`${base}/labels/next`, async (request, reply) => {
    void reply.header("cache-control", "no-store");
    return signalResearchLabelNext(deps, requireAuth(request).userId, request.query);
  });
  // Team kiểm TRƯỚC Idempotency-Key và trước khi parse tham số / body.
  app.put(`${base}/articles/:id/label`, async (request, reply) => {
    const auth = requireAuth(request);
    await requireTeam(deps.db, auth.userId, FORBIDDEN);
    void reply.header("cache-control", "no-store");
    return idempotent(deps.db, request, reply, auth.userId, deps.now(), async () => ({
      status: 200,
      body: await signalResearchSaveLabel(
        deps,
        auth.userId,
        request.params,
        request.body,
        request.ip,
      ),
    }));
  });
  app.get(`${base}/classifiers`, async (request, reply) => {
    void reply.header("cache-control", "no-store");
    return signalResearchClassifiers(deps, requireAuth(request).userId, request.query);
  });
}
