import {
  assertSignalTradeVisible,
  assertSignalVersionVisible,
  createSignalBotVersion,
  issueLabelToken,
  loadNextLabelArticle,
  loadSignalBotVersions,
  loadSignalClassifiers,
  loadSignalResearchArticles,
  loadSignalResearchArticleTrace,
  loadSignalResearchLatency,
  loadSignalResearchNewArticles,
  loadSignalResearchSummary,
  loadSignalResearchTrade,
  loadSignalResearchTrades,
  loadResearchWallets,
  loadSignalResearchExport,
  readOnlyTx,
  saveSignalClassificationLabel,
  ownerFor,
  setSignalBotVersionStatus,
  signalBotVersions,
  users,
  versionHiddenFrom,
  type Db,
  type ExitQuotes,
  type SignalVersionViewer,
} from "@drift/db";
import {
  AppError,
  ClassificationLabeler,
  ErrorCode,
  NEWS_LIMIT_DEFAULTS,
  UserRole,
  parseSrLane,
  parseSrQuotes,
  SR_LANE_KEY,
  SR_QUOTES_KEY,
  researchArticlesPageSchema,
  researchArticlesQuerySchema,
  researchArticleTraceSchema,
  researchLatencyQuerySchema,
  researchLatencySchema,
  researchNewArticlesQuerySchema,
  researchNewArticlesSchema,
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
  researchWalletsSchema,
  srExportFileName,
  srExportQuerySchema,
  srExportSchema,
  type ResearchWallets,
  srMarketsStale,
  STOCK_MARKET_SET,
  type ResearchVersionCreated,
  type SrMarketsSnapshot,
  type ResearchMarket,
  type ResearchMarkets,
  type ResearchVersion,
  type ResearchVersions,
  type ResearchArticle,
  type ResearchArticlesPage,
  type ResearchArticleTrace,
  type ResearchClaudeUsage,
  type ResearchLatency,
  type ResearchNewArticles,
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

// Signal research, lane tin tức (#271): chỉ role team (401 chưa đăng nhập, 403 người ngoài team, kiểm trước khi parse
// tham số), chỉ đọc (transaction READ ONLY, statement timeout). Không bao giờ chạm SoDEX (giá của lệnh đang mở chỉ đọc
// cache `md:last:*`). no-store. Ngoại lệ ghi (#304): `PUT /articles/:id/label` lưu nhãn phân loại của người gọi,
// bắt buộc Idempotency-Key, ghi audit; `GET /labels/next` ghi token gắn nhãn ngẫu nhiên (#348, sau khi đọc). #305: `POST /versions` (lưu News bot version bất biến) và
// `POST /versions/:id/status` (Pause / Resume / Stop / Retire), bắt buộc Idempotency-Key, audit trong service DB. Danh sách
// market SoDEX (`/markets`, kiểm tài sản khi lưu) chỉ đọc bản chụp Redis `sr:markets` do scheduler ghi.
//
// #423 (DEC-361): Signal Research ra menu chính (BETA). Phần trang người dùng test được dùng mở cho "team HOẶC
// `users.signal_research`" (`researchViewer`, kiểm trước khi parse và trước Idempotency-Key), gồm cả độ trễ theo chặng
// (`/latency`) và sức khoẻ nguồn (`sources`). Với người dùng test, API chỉ bỏ chi phí / token Claude (ô Claude cost, chi phí
// từng bài) trước khi trả (PM review #428). Version có chủ: version riêng của người khác → 404; version
// của team → người dùng test chỉ xem (403 khi đổi trạng thái); lưu version mới thì chủ là người gọi (team → version team).
// Nhãn ghi người chấm theo role lúc lưu (`team` / `tester`); cổng chỉ tính nhãn team.

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
  /**
   * #394: giá trị Redis `sr:lane` (chu kỳ và trần SoSoValue tháng scheduler đang dùng). Không truyền / không có / sai dạng
   * → `cycleMinutes` null ("Not available"), trần tháng theo mặc định.
   */
  srLane?: () => Promise<string | null>;
}

const NOT_ENABLED = "Signal Research is not turned on for this account.";

/**
 * #423: người xem của phần trang mở cho người dùng test: role team → `team`; cờ `users.signal_research` → người dùng test;
 * còn lại 403. Đọc role và cờ ngay lúc gọi (team tắt cờ thì request tiếp theo bị chặn).
 */
export async function researchViewer(db: Db, userId: string): Promise<SignalVersionViewer> {
  const [u] = await db
    .select({ role: users.role, on: users.signalResearch })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (u?.role === UserRole.team) return { userId, team: true };
  if (u?.on === true) return { userId, team: false };
  throw new AppError(ErrorCode.forbidden, NOT_ENABLED);
}

/** Chi phí / token Claude là dữ liệu chỉ team (#423): người dùng test nhận null, số lần gọi và model giữ nguyên. */
function claudeFor<T extends ResearchClaudeUsage | null>(viewer: SignalVersionViewer, u: T): T {
  if (viewer.team || u === null) return u;
  return { ...u, tokens: null, costUsd: null };
}

function articleFor(viewer: SignalVersionViewer, a: ResearchArticle): ResearchArticle {
  return viewer.team ? a : { ...a, claude: claudeFor(viewer, a.claude) };
}
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

/** Bản chụp `sr:lane` (#394); Redis lỗi hay giá trị sai → null (không đoán chu kỳ), có log cảnh báo. */
async function laneOf(deps: SignalResearchDeps) {
  if (deps.srLane === undefined) return null;
  try {
    const raw = await deps.srLane();
    const lane = parseSrLane(raw);
    if (raw !== null && lane === null)
      deps.log?.warn({ key: SR_LANE_KEY }, "signal research lane snapshot unreadable");
    return lane;
  } catch (e) {
    deps.log?.warn(
      { key: SR_LANE_KEY, err: e instanceof Error ? e.name : "error" },
      "signal research lane snapshot unavailable",
    );
    return null;
  }
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
  const viewer = await researchViewer(deps.db, userId);
  const { range, versionId } = parseOrThrow(researchSummaryQuerySchema, query);
  await assertSignalVersionVisible(deps.db, versionId, viewer);
  const lane = await laneOf(deps);
  const out = await tx(deps, (q, check) =>
    loadSignalResearchSummary(
      q,
      deps.now(),
      {
        sosoMonthlyLimit: lane?.sosoMonthlyLimit ?? NEWS_LIMIT_DEFAULTS.sosoMonthlyLimit,
        claudeDailyInputBudget: NEWS_LIMIT_DEFAULTS.claudeDailyInputBudget,
        cycleMinutes: lane?.cycleMinutes ?? null,
      },
      check,
      range,
      quotesOf(deps),
      versionId,
    ),
  );
  const parsed = researchSummarySchema.parse(out);
  if (viewer.team) return parsed;
  // Người dùng test: chỉ không có ô Claude cost (chỉ team).
  return {
    ...parsed,
    funnel:
      parsed.funnel === null
        ? null
        : { ...parsed.funnel, claudeCost: null, claudeCostPerDay: null },
  };
}

export async function signalResearchTrades(
  deps: SignalResearchDeps,
  userId: string,
  query: unknown,
): Promise<ResearchTradesPage> {
  const viewer = await researchViewer(deps.db, userId);
  const q = parseOrThrow(researchTradesQuerySchema, query);
  await assertSignalVersionVisible(deps.db, q.versionId, viewer);
  const out = await tx(deps, (t) => loadSignalResearchTrades(t, q, deps.now(), quotesOf(deps)));
  return researchTradesPageSchema.parse(out);
}

export async function signalResearchTrade(
  deps: SignalResearchDeps,
  userId: string,
  id: string,
  query: unknown,
): Promise<ResearchTradeDetail> {
  const viewer = await researchViewer(deps.db, userId);
  parseOrThrow(tzQuery, query);
  await assertSignalTradeVisible(deps.db, id, viewer);
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
  const viewer = await researchViewer(deps.db, userId);
  const q = parseOrThrow(researchArticlesQuerySchema, query);
  await assertSignalVersionVisible(deps.db, q.versionId, viewer);
  const out = researchArticlesPageSchema.parse(
    await tx(deps, (t, check) => loadSignalResearchArticles(t, q, deps.now(), check)),
  );
  return viewer.team ? out : { ...out, items: out.items.map((a) => articleFor(viewer, a)) };
}

/** Bài mới sau con trỏ `since` (#345): hiệu ứng bài rơi xuống phễu, web hỏi mỗi 15 s khi tab hiển thị. */
export async function signalResearchNewArticles(
  deps: SignalResearchDeps,
  userId: string,
  query: unknown,
): Promise<ResearchNewArticles> {
  const viewer = await researchViewer(deps.db, userId);
  const q = parseOrThrow(researchNewArticlesQuerySchema, query);
  await assertSignalVersionVisible(deps.db, q.versionId, viewer);
  const out = researchNewArticlesSchema.parse(
    await tx(deps, (t, check) => loadSignalResearchNewArticles(t, q, deps.now(), check)),
  );
  return viewer.team ? out : { ...out, items: out.items.map((a) => articleFor(viewer, a)) };
}

/**
 * Độ trễ theo chặng (#375): median từng chặng published → collected → Claude done → decided → opened trong cửa sổ 1d / 7d,
 * kèm số bài đo được. Chặng nguồn gốc → SoSoValue luôn null (không có nguồn). #423: team hoặc người dùng test.
 */
export async function signalResearchLatency(
  deps: SignalResearchDeps,
  userId: string,
  query: unknown,
): Promise<ResearchLatency> {
  const viewer = await researchViewer(deps.db, userId);
  const q = parseOrThrow(researchLatencyQuerySchema, query);
  await assertSignalVersionVisible(deps.db, q.versionId, viewer);
  const out = await tx(deps, (t, check) => loadSignalResearchLatency(t, q, deps.now(), check));
  return researchLatencySchema.parse(out);
}

/** Trace một bài qua 5 bước (#291). Bài không có / backlog / version khác → 404. */
export async function signalResearchArticleTrace(
  deps: SignalResearchDeps,
  userId: string,
  id: string,
  query: unknown,
): Promise<ResearchArticleTrace> {
  const viewer = await researchViewer(deps.db, userId);
  const { versionId } = parseOrThrow(researchTraceQuerySchema, query);
  await assertSignalVersionVisible(deps.db, versionId, viewer);
  const out = await tx(deps, (t, check) =>
    loadSignalResearchArticleTrace(t, id, check, userId, versionId),
  );
  if (out === null) throw new AppError(ErrorCode.notFound, "Article not found.");
  const trace = researchArticleTraceSchema.parse(out);
  if (viewer.team) return trace;
  return {
    ...trace,
    article: articleFor(viewer, trace.article),
    steps: trace.steps.map<ResearchArticleTrace["steps"][number]>((st) =>
      st.key === "score" && st.detail !== null
        ? { ...st, detail: { ...st.detail, claude: claudeFor(viewer, st.detail.claude) } }
        : st,
    ),
  };
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
  const viewer = await researchViewer(deps.db, userId);
  parseOrThrow(tzQuery, query);
  const out = await tx(deps, (t) => loadNextLabelArticle(t, userId));
  const labelToken =
    out.item === null
      ? null
      : await issueLabelToken(deps.db, { userId, articleId: out.item.article.id, now: deps.now() });
  const next = researchLabelNextSchema.parse({ ...out, labelToken });
  if (viewer.team || next.item === null) return next;
  return {
    ...next,
    item: {
      ...next.item,
      classification: {
        ...next.item.classification,
        claude: claudeFor(viewer, next.item.classification.claude),
      },
    },
  };
}

/** Lưu (upsert) nhãn của người gọi cho một bài tín hiệu; trả nhãn + kết quả lệnh của bài (đã lưu nên không còn ẩn). */
export async function signalResearchSaveLabel(
  deps: SignalResearchDeps,
  viewer: SignalVersionViewer,
  params: unknown,
  body: unknown,
  ip: string | null,
): Promise<ResearchLabelSaved> {
  const userId = viewer.userId;
  const { id } = parseOrThrow(articleParams, params);
  const b = parseOrThrow(researchLabelBodySchema, body);
  const out = await saveSignalClassificationLabel(deps.db, {
    articleId: id,
    userId,
    verdict: b.verdict,
    reason: b.reason ?? null,
    note: b.note ?? null,
    labelToken: b.labelToken ?? null,
    // #423: người chấm theo role lúc lưu; cổng chỉ tính nhãn team.
    labeler: viewer.team ? ClassificationLabeler.team : ClassificationLabeler.tester,
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
  await researchViewer(deps.db, userId);
  parseOrThrow(tzQuery, query);
  const out = await tx(deps, (t, check) => loadSignalClassifiers(t, check));
  return researchClassifiersSchema.parse(out);
}

/**
 * Research wallets (#353): tập ví nghiên cứu mới nhất của H1, hạng, lần đọc được gần nhất, có trang trader hay không. Chỉ đọc
 * DB trong transaction READ ONLY; không gọi Hyperliquid.
 */
export async function signalResearchWallets(
  deps: SignalResearchDeps,
  userId: string,
  query: unknown,
): Promise<ResearchWallets> {
  await researchViewer(deps.db, userId);
  parseOrThrow(tzQuery, query);
  const out = await tx(deps, (t) => loadResearchWallets(t, deps.now()));
  return researchWalletsSchema.parse(out);
}

// ── News bot versions (#305) ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Version người xem thấy được (team: version của team; người dùng test: version của team + My versions), mới nhất trước,
 * kèm số dư, giới hạn, lệnh bị chặn, cổng; số version đang chạy / đã thử của chủ người xem; classifier.
 */
export async function signalResearchVersions(
  deps: SignalResearchDeps,
  userId: string,
  query: unknown,
): Promise<ResearchVersions> {
  const viewer = await researchViewer(deps.db, userId);
  parseOrThrow(tzQuery, query);
  const out = await tx(deps, (t, check) => loadSignalBotVersions(t, deps.now(), check, viewer));
  return researchVersionsSchema.parse(out);
}

async function versionItem(
  deps: SignalResearchDeps,
  id: string,
  viewer: SignalVersionViewer,
): Promise<ResearchVersion> {
  const all = await tx(deps, (t, check) => loadSignalBotVersions(t, deps.now(), check, viewer));
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
  await researchViewer(deps.db, userId);
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
 * version chạy MỖI CHỦ (409 `MAX_RUNNING_VERSIONS`, trong service DB). #423: chủ = người gọi (team → version của team,
 * người dùng test → My versions); version gốc phải là version người gọi thấy được (không thì như không có).
 */
export async function signalResearchCreateVersion(
  deps: SignalResearchDeps,
  viewer: SignalVersionViewer,
  body: unknown,
  ip: string | null,
): Promise<ResearchVersionCreated> {
  const userId = viewer.userId;
  const b = parseOrThrow(researchVersionCreateBodySchema, body);
  const from = b.savedFromVersionId ?? null;
  if (from !== null) {
    const [row] = await deps.db
      .select({ id: signalBotVersions.id, owner: signalBotVersions.ownerUserId })
      .from(signalBotVersions)
      .where(eq(signalBotVersions.id, from));
    if (row === undefined || versionHiddenFrom(row.owner, viewer))
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
    hypothesis: b.hypothesis,
    ownerUserId: ownerFor(viewer),
    ip,
    now: deps.now(),
  });
  // DEC-334: version đã commit; lỗi sau đây (đọc lại danh sách) không được giải phóng key, tránh lưu hai lần khi retry.
  markSideEffect();
  return researchVersionCreatedSchema.parse({
    ...(await versionItem(deps, v.id, viewer)),
    warnings,
  });
}

/**
 * Pause / Resume / Stop / Retire (running ↔ paused; running / paused → stopped; stopped → retired). #423: version riêng
 * của người khác → 404; version của team mà người gọi không phải team → 403.
 */
export async function signalResearchSetVersionStatus(
  deps: SignalResearchDeps,
  viewer: SignalVersionViewer,
  params: unknown,
  body: unknown,
  ip: string | null,
): Promise<ResearchVersion> {
  const { id } = parseOrThrow(researchVersionParamsSchema, params);
  const b = parseOrThrow(researchVersionStatusBodySchema, body);
  await setSignalBotVersionStatus(deps.db, {
    id,
    status: b.status,
    userId: viewer.userId,
    viewer,
    ip,
    now: deps.now(),
  });
  markSideEffect();
  return versionItem(deps, id, viewer);
}

/** Trần tổng thời gian của request Export data (nhiều câu hơn các trang; mỗi câu vẫn bị `statement_timeout`). */
const EXPORT_DEADLINE_MS = 45_000;

/**
 * Export data (#489): một file JSON cho PM phân tích, CHỈ role team (người dùng test bật cờ cũng 403), kiểm trước khi parse
 * tham số. Chỉ đọc. Nội dung theo `srExportSchema` (không email / user id / ví / key / token / id bot mainnet); parse lại
 * trước khi trả để không lọt trường ngoài hợp đồng.
 */
export async function signalResearchExport(
  deps: SignalResearchDeps,
  userId: string,
  query: unknown,
): Promise<{ fileName: string; body: string }> {
  const viewer = await researchViewer(deps.db, userId);
  if (!viewer.team)
    throw new AppError(ErrorCode.forbidden, "Export data is for the DeskLabs team only.");
  const { period } = parseOrThrow(srExportQuerySchema, query);
  const now = deps.now();
  const lane = await laneOf(deps);
  const out = await readOnlyTx(
    deps.db,
    {
      statementTimeoutMs: deps.queryTimeoutMs ?? QUERY_TIMEOUT_MS,
      deadlineMs: EXPORT_DEADLINE_MS,
    },
    (q, check) =>
      loadSignalResearchExport(q, { period, now, cycleMinutes: lane?.cycleMinutes ?? null }, check),
  );
  return {
    fileName: srExportFileName(period, now),
    body: JSON.stringify(srExportSchema.parse(out), null, 2),
  };
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
  app.get(`${base}/latency`, async (request, reply) => {
    void reply.header("cache-control", "no-store");
    return signalResearchLatency(deps, requireAuth(request).userId, request.query);
  });
  app.get(`${base}/articles/new`, async (request, reply) => {
    void reply.header("cache-control", "no-store");
    return signalResearchNewArticles(deps, requireAuth(request).userId, request.query);
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
  // Quyền (team hoặc cờ) kiểm TRƯỚC Idempotency-Key và trước khi parse tham số / body.
  app.put(`${base}/articles/:id/label`, async (request, reply) => {
    const auth = requireAuth(request);
    const viewer = await researchViewer(deps.db, auth.userId);
    void reply.header("cache-control", "no-store");
    return idempotent(deps.db, request, reply, auth.userId, deps.now(), async () => ({
      status: 200,
      body: await signalResearchSaveLabel(deps, viewer, request.params, request.body, request.ip),
    }));
  });
  app.get(`${base}/classifiers`, async (request, reply) => {
    void reply.header("cache-control", "no-store");
    return signalResearchClassifiers(deps, requireAuth(request).userId, request.query);
  });
  app.get(`${base}/research-wallets`, async (request, reply) => {
    void reply.header("cache-control", "no-store");
    return signalResearchWallets(deps, requireAuth(request).userId, request.query);
  });
  app.get(`${base}/versions`, async (request, reply) => {
    void reply.header("cache-control", "no-store");
    return signalResearchVersions(deps, requireAuth(request).userId, request.query);
  });
  app.get(`${base}/export`, async (request, reply) => {
    const file = await signalResearchExport(deps, requireAuth(request).userId, request.query);
    return reply
      .header("Content-Type", "application/json; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="${file.fileName}"`)
      .header("Cache-Control", "no-store")
      .send(file.body);
  });
  app.get(`${base}/markets`, async (request, reply) => {
    void reply.header("cache-control", "no-store");
    return signalResearchMarkets(deps, requireAuth(request).userId, request.query);
  });
  // Quyền (team hoặc cờ) kiểm TRƯỚC Idempotency-Key và trước khi parse tham số / body; quyền theo chủ ở service DB.
  app.post(`${base}/versions`, async (request, reply) => {
    const auth = requireAuth(request);
    const viewer = await researchViewer(deps.db, auth.userId);
    void reply.header("cache-control", "no-store");
    return idempotent(deps.db, request, reply, auth.userId, deps.now(), async () => ({
      status: 201,
      body: await signalResearchCreateVersion(deps, viewer, request.body, request.ip),
    }));
  });
  app.post(`${base}/versions/:id/status`, async (request, reply) => {
    const auth = requireAuth(request);
    const viewer = await researchViewer(deps.db, auth.userId);
    void reply.header("cache-control", "no-store");
    return idempotent(deps.db, request, reply, auth.userId, deps.now(), async () => ({
      status: 200,
      body: await signalResearchSetVersionStatus(
        deps,
        viewer,
        request.params,
        request.body,
        request.ip,
      ),
    }));
  });
}
