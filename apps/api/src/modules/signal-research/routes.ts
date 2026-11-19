import {
  createSignalBotVersion,
  issueLabelToken,
  loadNextLabelArticle,
  loadSignalBotVersions,
  loadSignalClassifiers,
  loadSignalResearchArticles,
  loadSignalResearchArticleTrace,
  loadSignalResearchSummary,
  loadSignalResearchTrade,
  loadSignalResearchTrades,
  readOnlyTx,
  saveSignalClassificationLabel,
  setSignalBotVersionStatus,
  signalBotVersions,
  type Db,
  type ExitQuotes,
} from "@drift/db";
import {
  AppError,
  ErrorCode,
  NEWS_LIMIT_DEFAULTS,
  parseSrQuotes,
  SR_QUOTES_KEY,
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
  researchTraceQuerySchema,
  researchMarketsSchema,
  researchVersionCreateBodySchema,
  researchVersionParamsSchema,
  researchVersionSchema,
  researchVersionsSchema,
  researchVersionStatusBodySchema,
  parseSrMarkets,
  researchVersionCreatedSchema,
  srMarketsStale,
  STOCK_MARKET_SET,
  type ResearchVersionCreated,
  type SrMarketsSnapshot,
  type ResearchMarket,
  type ResearchMarkets,
  type ResearchVersion,
  type ResearchVersions,
  type ResearchArticlesPage,
  type ResearchArticleTrace,
  type ResearchClassifiers,
  type ResearchLabelNext,
  type ResearchLabelSaved,
  type ResearchSummary,
  type ResearchTradeDetail,
  type ResearchTradesPage,
} from "@drift/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { parseOrThrow } from "../../lib/http";
import { idempotent, markSideEffect } from "../../lib/idempotency";
import { requireAuth } from "../../plugins/session";
import { requireTeam } from "../account/team";

// Signal research, lane tin tức (#271): chỉ role team (401 chưa đăng nhập, 403 người ngoài team, kiểm trước khi parse
// tham số), chỉ đọc (transaction READ ONLY, statement timeout). Không bao giờ chạm SoDEX (giá của lệnh đang mở chỉ đọc
// cache `md:last:*`). no-store. Ngoại lệ ghi (#304): `PUT /articles/:id/label` lưu nhãn phân loại của người gọi,
// bắt buộc Idempotency-Key, ghi audit; `GET /labels/next` ghi token gắn nhãn ngẫu nhiên (#348, sau khi đọc). #305: `POST /versions` (lưu News bot version bất biến) và
// `POST /versions/:id/status` (Pause / Resume / Stop / Retire), bắt buộc Idempotency-Key, audit trong service DB. Danh sách
// market SoDEX (`/markets`, kiểm tài sản khi lưu) chỉ đọc bản chụp Redis `sr:markets` do scheduler ghi.

export interface SignalResearchDeps {
  db: Db;
  now: () => Date;
  /** Statement timeout (ms) của transaction; mặc định 10 s. */
  queryTimeoutMs?: number;
  /**
   * #308: giá trị Redis `sr:quotes` (bid / ask SoDEX do watcher của scheduler ghi) cho lãi / lỗ chưa chốt của lệnh giấy
   * đang mở: Long theo bid, Short theo ask, giá cũ bị bỏ. Chỉ đọc cache, không gọi SoDEX. Không truyền → không có lãi /
   * lỗ chưa chốt.
   */
  srQuotes?: () => Promise<string | null>;
  /** Log cảnh báo (mục `sr:quotes` sai dạng). `registerSignalResearchRoutes` dùng logger của Fastify. */
  log?: { warn: (obj: object, msg: string) => void };
  /**
   * #305: giá trị Redis `sr:markets` (bản chụp danh sách perps SoDEX do scheduler ghi); null = chưa có. Module này không
   * bao giờ chạm SoDEX (DEC-322 / DEC-327; PM chọn phương án (a) ở review #324).
   */
  srMarkets: () => Promise<string | null>;
}

const FORBIDDEN = "Signal research is for the DeskLabs team only.";
const QUERY_TIMEOUT_MS = 10_000;
/** `tz` chỉ để web dùng chung key cache; API trả giờ UTC. */
const tzQuery = z.object({ tz: z.string().max(64).optional() });
const articleParams = z.object({ id: z.string().min(1).max(200) });

/** Trần tổng thời gian của một request (giữa các câu; mỗi câu còn bị `statement_timeout`). */
const DEADLINE_MS = 20_000;

/**
 * Bản chụp `sr:quotes` đã parse; không có nguồn → undefined (không tính lãi / lỗ chưa chốt). Mục sai dạng chỉ bỏ market
 * đó và log tên market (không log giá trị).
 */
function quotesOf(deps: SignalResearchDeps): ExitQuotes | undefined {
  const read = deps.srQuotes;
  if (read === undefined) return undefined;
  return async () => {
    const p = parseSrQuotes(await read());
    if (p.broken)
      deps.log?.warn({ key: SR_QUOTES_KEY }, "signal research quotes snapshot unreadable");
    else if (p.invalid.length > 0)
      deps.log?.warn(
        {
          key: SR_QUOTES_KEY,
          invalidCount: p.invalid.length,
          markets: p.invalid.slice(0, 20).map((m) => m.slice(0, 64)),
        },
        "signal research quotes snapshot has invalid entries",
      );
    return p.quotes;
  };
}

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
  const { range, versionId } = parseOrThrow(researchSummaryQuerySchema, query);
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
      quotesOf(deps),
      versionId,
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
  const out = await tx(deps, (t) => loadSignalResearchTrades(t, q, deps.now(), quotesOf(deps)));
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
  const out = await tx(deps, (t) => loadSignalResearchTrade(t, id, deps.now(), quotesOf(deps)));
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
  const { versionId } = parseOrThrow(researchTraceQuerySchema, query);
  const out = await tx(deps, (t, check) =>
    loadSignalResearchArticleTrace(t, id, check, userId, versionId),
  );
  if (out === null) throw new AppError(ErrorCode.notFound, "Article not found.");
  return researchArticleTraceSchema.parse(out);
}

/**
 * Bài ngẫu nhiên để gắn nhãn (#304): trong các bài classifier hiện tại gọi là tín hiệu mà người gọi chưa gắn nhãn. Không
 * có bất kỳ trường kết quả nào (schema strict), để kết quả lệnh không ảnh hưởng nhãn. #348: chọn bài trong transaction
 * READ ONLY, rồi cấp token gắn nhãn ngẫu nhiên (ghi `signal_label_tokens`, ngoài transaction đọc) cho đúng bài đó; chỉ
 * PUT kèm token này mới được nhãn `random`.
 */
export async function signalResearchLabelNext(
  deps: SignalResearchDeps,
  userId: string,
  query: unknown,
): Promise<ResearchLabelNext> {
  await requireTeam(deps.db, userId, FORBIDDEN);
  parseOrThrow(tzQuery, query);
  const out = await tx(deps, (t) => loadNextLabelArticle(t, userId));
  const labelToken =
    out.item === null
      ? null
      : await issueLabelToken(deps.db, { userId, articleId: out.item.article.id, now: deps.now() });
  return researchLabelNextSchema.parse({ ...out, labelToken });
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
    labelToken: b.labelToken ?? null,
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

// ── News bot versions (#305) ─────────────────────────────────────────────────────────────────────────────────────

/** Mọi version, mới nhất trước, kèm số dư, giới hạn, lệnh bị chặn, cổng; số version đang chạy / đã thử; classifier. */
export async function signalResearchVersions(
  deps: SignalResearchDeps,
  userId: string,
  query: unknown,
): Promise<ResearchVersions> {
  await requireTeam(deps.db, userId, FORBIDDEN);
  parseOrThrow(tzQuery, query);
  const out = await tx(deps, (t, check) => loadSignalBotVersions(t, deps.now(), check));
  return researchVersionsSchema.parse(out);
}

async function versionItem(deps: SignalResearchDeps, id: string): Promise<ResearchVersion> {
  const all = await tx(deps, (t, check) => loadSignalBotVersions(t, deps.now(), check));
  const v = all.items.find((x) => x.id === id);
  if (v === undefined) throw new AppError(ErrorCode.notFound, "Version not found.");
  return researchVersionSchema.parse(v);
}

const KIND_ORDER = { crypto: 0, stock: 1 } as const;

/** Bản chụp `sr:markets`; thiếu, hỏng hoặc Redis lỗi → null. */
async function readMarkets(deps: SignalResearchDeps): Promise<SrMarketsSnapshot | null> {
  try {
    return parseSrMarkets(await deps.srMarkets());
  } catch {
    return null;
  }
}

/** Perps SoDEX đang listed (mọi trạng thái), crypto trước rồi cổ phiếu (`STOCK_MARKET_SET`), mỗi nhóm theo tên. */
function listedMarkets(snap: SrMarketsSnapshot): ResearchMarket[] {
  return snap.markets
    .map((m): ResearchMarket => ({
      market: m.name,
      base: m.baseCoin ?? m.name.replace(/-USD$/, ""),
      displayName: m.displayName,
      kind: STOCK_MARKET_SET.has(m.name) ? "stock" : "crypto",
      status: m.status,
    }))
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.market.localeCompare(b.market));
}

/** Chưa có bản chụp → `items: null`, `stale: true` (không bao giờ là danh sách rỗng); cũ hơn 15 phút → `stale: true`. */
export async function signalResearchMarkets(
  deps: SignalResearchDeps,
  userId: string,
  query: unknown,
): Promise<ResearchMarkets> {
  await requireTeam(deps.db, userId, FORBIDDEN);
  parseOrThrow(tzQuery, query);
  const snap = await readMarkets(deps);
  return researchMarketsSchema.parse(
    snap === null
      ? { items: null, updatedAt: null, stale: true }
      : {
          items: listedMarkets(snap),
          updatedAt: snap.updatedAt,
          stale: srMarketsStale(snap, deps.now()),
        },
  );
}

/**
 * Lưu một version mới (bất biến; không có route sửa). Kiểm: config (zod, TP tối thiểu ≥ 1× chi phí…), version gốc có
 * thật, mọi tài sản trong danh sách có trong bản chụp `sr:markets` (chỉ khi danh sách không rỗng: chưa có bản chụp →
 * 503 `MARKET_LIST_UNAVAILABLE`; bản chụp cũ vẫn kiểm theo nó và lưu được, kèm cảnh báo `market_list_stale`), tối đa 3
 * version chạy (409 `MAX_RUNNING_VERSIONS`, trong service DB).
 */
export async function signalResearchCreateVersion(
  deps: SignalResearchDeps,
  userId: string,
  body: unknown,
  ip: string | null,
): Promise<ResearchVersionCreated> {
  const b = parseOrThrow(researchVersionCreateBodySchema, body);
  const from = b.savedFromVersionId ?? null;
  if (from !== null) {
    const [row] = await deps.db
      .select({ id: signalBotVersions.id })
      .from(signalBotVersions)
      .where(eq(signalBotVersions.id, from));
    if (row === undefined)
      throw new AppError(ErrorCode.validationFailed, "Invalid input.", {
        fieldErrors: { savedFromVersionId: ["not_found"] },
      });
  }
  const wanted = [...new Set(b.config.assets.markets)];
  const warnings: ResearchVersionCreated["warnings"] = [];
  if (wanted.length > 0) {
    const snap = await readMarkets(deps);
    if (snap === null)
      throw new AppError(
        ErrorCode.marketListUnavailable,
        "The SoDEX market list is not available yet. Try again in a few minutes.",
        { reason: "MARKET_LIST_MISSING" },
      );
    if (srMarketsStale(snap, deps.now())) warnings.push("market_list_stale");
    const listed = new Set(snap.markets.map((m) => m.name));
    const unknown = wanted.filter((m) => !listed.has(m)).sort();
    if (unknown.length > 0)
      throw new AppError(ErrorCode.validationFailed, "Invalid input.", {
        fieldErrors: { "config.assets.markets": ["not_listed"] },
        markets: unknown,
      });
  }
  const v = await createSignalBotVersion(deps.db, {
    name: b.name,
    config: b.config,
    createdBy: userId,
    savedFromVersionId: from,
    start: b.start,
    ip,
    now: deps.now(),
  });
  // DEC-334: version đã commit; lỗi sau đây (đọc lại danh sách) không được giải phóng key, tránh lưu hai lần khi retry.
  markSideEffect();
  return researchVersionCreatedSchema.parse({ ...(await versionItem(deps, v.id)), warnings });
}

/** Pause / Resume / Stop / Retire (running ↔ paused; running / paused → stopped; stopped → retired). */
export async function signalResearchSetVersionStatus(
  deps: SignalResearchDeps,
  userId: string,
  params: unknown,
  body: unknown,
  ip: string | null,
): Promise<ResearchVersion> {
  const { id } = parseOrThrow(researchVersionParamsSchema, params);
  const b = parseOrThrow(researchVersionStatusBodySchema, body);
  await setSignalBotVersionStatus(deps.db, { id, status: b.status, userId, ip, now: deps.now() });
  markSideEffect();
  return versionItem(deps, id);
}

export function registerSignalResearchRoutes(
  app: FastifyInstance,
  input: SignalResearchDeps,
): void {
  const deps: SignalResearchDeps = { ...input, log: input.log ?? app.log };
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
  app.get(`${base}/versions`, async (request, reply) => {
    void reply.header("cache-control", "no-store");
    return signalResearchVersions(deps, requireAuth(request).userId, request.query);
  });
  app.get(`${base}/markets`, async (request, reply) => {
    void reply.header("cache-control", "no-store");
    return signalResearchMarkets(deps, requireAuth(request).userId, request.query);
  });
  // Team kiểm TRƯỚC Idempotency-Key và trước khi parse tham số / body.
  app.post(`${base}/versions`, async (request, reply) => {
    const auth = requireAuth(request);
    await requireTeam(deps.db, auth.userId, FORBIDDEN);
    void reply.header("cache-control", "no-store");
    return idempotent(deps.db, request, reply, auth.userId, deps.now(), async () => ({
      status: 201,
      body: await signalResearchCreateVersion(deps, auth.userId, request.body, request.ip),
    }));
  });
  app.post(`${base}/versions/:id/status`, async (request, reply) => {
    const auth = requireAuth(request);
    await requireTeam(deps.db, auth.userId, FORBIDDEN);
    void reply.header("cache-control", "no-store");
    return idempotent(deps.db, request, reply, auth.userId, deps.now(), async () => ({
      status: 200,
      body: await signalResearchSetVersionStatus(
        deps,
        auth.userId,
        request.params,
        request.body,
        request.ip,
      ),
    }));
  });
}
