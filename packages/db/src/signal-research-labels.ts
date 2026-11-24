import { createHash, randomBytes } from "node:crypto";

import {
  AppError,
  articleClaudeUsage,
  articleVerdict,
  ClassificationLabeler,
  testerAgreement,
  CLASSIFICATION_WRONG_REASONS,
  CLASSIFIER_GATE,
  ClassificationLabelSource,
  classifierGate,
  commonMistakes,
  dec,
  ErrorCode,
  LABEL_TOKEN_TTL_MIN,
  NEWS_CLASSIFIER,
  sourceTierOf,
  type ClassificationVerdict,
  type ClassificationWrongReason,
  type ClassifierGate,
  type ClassifierGateStatus,
  type ResearchClaudeUsage,
  type ResearchClassifiers,
  type ResearchLabelNext,
  type ResearchLabelSaved,
  type ResearchLabelTradeResult,
  type ResearchMyLabel,
} from "@drift/shared";
import { and, asc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";

import type { Db } from "./client";
import type { DbTx } from "./read-only";
import {
  auditLog,
  signalArticles,
  signalClassificationLabels,
  signalClassifierVersions,
  signalLabelTokens,
  signalPaperTrades,
} from "./schema";
import { newsTypeOrNull } from "./signal-research-keys";

// Nhãn phân loại và cổng precision của classifier (#304, DEC-328 mục 2; hợp đồng packages/shared/src/api/signal-research.ts).
//
// Tổng thể của precision = bài mà classifier gọi là tín hiệu: đã phân loại, có version prompt, catalyst ≠ none và có event
// Understand `pass` (qua bước Score). Precision của một classifier = số bài kết luận Right / số bài có ít nhất một nhãn;
// nhiều người gắn nhãn khác nhau thì theo đa số, hoà tính Wrong (`articleVerdict`). Cổng: ≥ 50 bài có nhãn và ≥ 80%
// (`classifierGate`). Lệnh chỉ tính cổng khi classifier tạo ra nó (`signal_paper_trades.classifier_version`) đã qua.
//
// Nguồn nhãn (#348, DEC-340): precision, khoảng Wilson và cổng CHỈ tính nhãn `random`. Nhãn là `random`
// khi PUT kèm token do `GET /labels/next` cấp cho đúng người và đúng bài (bài server chọn ngẫu nhiên, chưa thấy kết quả
// lệnh): token 32 byte ngẫu nhiên, chỉ lưu sha256 trong `signal_label_tokens`, hết hạn sau LABEL_TOKEN_TTL_MIN phút, dùng
// một lần, và chỉ nhận khi người gọi CHƯA có nhãn cho bài. Sửa một nhãn `random` mà giữ nguyên Right / Wrong (đổi lý do,
// ghi chú) thì vẫn `random`; đổi Right / Wrong thì thành `trace` (có thể đã thấy kết quả lệnh). Mọi trường hợp khác (không
// token, token sai / hết hạn / đã dùng / của bài khác) vẫn lưu, nhưng là `trace`. "Most common mistakes" đếm cả hai.
//
// Người chấm (#423, DEC-361): `labeler` ghi lúc lưu theo role của người gọi (`team` / `tester`). Mọi số của
// precision, cổng, "from traces" và "Most common mistakes" CHỈ tính nhãn `team`; nhãn `tester` chỉ vào `testers` (mức
// đồng thuận với nhãn `random` của team, cùng tập với cổng) để đối chiếu.

type Q = Db | DbTx;
type Exec = Pick<Db, "select" | "execute">;

export const SignalLabelAudit = { saved: "signal_research.label_saved" } as const;

/** Điều kiện SQL "bài `a` là tín hiệu của classifier đã đọc nó" (alias bảng bài phải là `a`). */
const IS_SIGNAL = sql`(
  a.status = 'classified' and a.claude_prompt_version is not null
  and coalesce(a.classification->>'catalyst', 'none') <> 'none'
  and exists (
    select 1 from signal_events e
    where e.article_id = a.id and e.rule_version = a.rule_version
      and e.stage = 'understand' and e.outcome = 'pass'
  )
)`;

const iso = (d: Date) => d.toISOString();
const toDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));

const classificationSchema = z.looseObject({
  catalyst: z.string().optional(),
  market: z.string().nullable().optional(),
  relevance: z.string().optional(),
  promotional: z.boolean().optional(),
  eventDate: z.string().nullable().optional(),
});
const understandDetail = z.looseObject({ market: z.string().optional() });
const matchedList = z.array(z.object({ symbol: z.string() }));
const parseOr = <T>(schema: z.ZodType<T>, v: unknown, fallback: T): T => {
  const p = schema.safeParse(v);
  return p.success ? p.data : fallback;
};

function usageOf(a: typeof signalArticles.$inferSelect): ResearchClaudeUsage | null {
  const u = articleClaudeUsage(a);
  return u === null
    ? null
    : {
        calls: u.calls,
        tokens: u.tokens,
        costUsd: u.costUsd,
        model: u.model,
        promptVersion: u.promptVersion,
      };
}

const reasonOf = (r: string | null): ClassificationWrongReason | null =>
  r !== null && (CLASSIFICATION_WRONG_REASONS as readonly string[]).includes(r)
    ? (r as ClassificationWrongReason)
    : null;

function labelOut(r: typeof signalClassificationLabels.$inferSelect): ResearchMyLabel {
  return {
    classifierVersion: r.classifierVersion,
    // 4 ký tự hex cuối id người gắn (như `createdBy` của version), không lộ id đầy đủ.
    labeledBy: r.labeledBy.replace(/-/g, "").slice(-4).toLowerCase(),
    verdict: r.verdict === "wrong" ? "wrong" : "right",
    reason: reasonOf(r.reason),
    note: r.note,
    source: r.source === "random" ? "random" : "trace",
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
}

/** Bài có phải tín hiệu của classifier đã đọc nó không; trả version prompt khi phải, null khi không / không có bài. */
export async function signalClassifierOf(q: Exec, articleId: string): Promise<string | null> {
  const r = await q.execute<{ v: string }>(sql`
    select a.claude_prompt_version as v from signal_articles a where a.id = ${articleId} and ${IS_SIGNAL}`);
  return r.rows[0]?.v ?? null;
}

/** Nhãn của một người cho một bài (null = chưa gắn). */
export async function loadMyLabel(
  q: Exec,
  articleId: string,
  userId: string,
): Promise<ResearchMyLabel | null> {
  const [r] = await q
    .select()
    .from(signalClassificationLabels)
    .where(
      and(
        eq(signalClassificationLabels.articleId, articleId),
        eq(signalClassificationLabels.labeledBy, userId),
      ),
    );
  return r === undefined ? null : labelOut(r);
}

/**
 * Một bài NGẪU NHIÊN (đều) trong các bài classifier hiện tại gọi là tín hiệu mà người này chưa gắn nhãn, để tỉ lệ không
 * bị lệch theo bài người ta chọn. SQL: lọc tập ứng viên rồi `order by random() limit 1` (mỗi dòng nhận một số ngẫu nhiên
 * độc lập nên mọi bài có cùng xác suất; quét toàn bộ tập ứng viên, chấp nhận được vì tín hiệu chỉ vài trăm / vài nghìn
 * bài). `count(*) over ()` tính trước `limit` nên ra đúng số bài còn lại. Không trả bất kỳ trường kết quả nào.
 */
export async function loadNextLabelArticle(
  q: Exec,
  userId: string,
): Promise<Omit<ResearchLabelNext, "labelToken">> {
  const r = await q.execute<{ id: string; remaining: string | number; u_detail: unknown }>(sql`
    select a.id, count(*) over () as remaining,
      (select e.detail from signal_events e
        where e.article_id = a.id and e.rule_version = a.rule_version
          and e.stage = 'understand' and e.outcome = 'pass'
        order by e.at desc, e.id limit 1) as u_detail
    from signal_articles a
    where ${IS_SIGNAL} and a.claude_prompt_version = ${NEWS_CLASSIFIER.promptVersion}
      and not exists (
        select 1 from signal_classification_labels l where l.article_id = a.id and l.labeled_by = ${userId}
      )
    order by random()
    limit 1`);
  const row = r.rows[0];
  if (row === undefined) return { item: null, remaining: 0 };
  const [a] = await q.select().from(signalArticles).where(eq(signalArticles.id, row.id));
  if (a === undefined || a.claudePromptVersion === null) return { item: null, remaining: 0 };
  const cls = parseOr(classificationSchema, a.classification, {});
  const ud = parseOr(understandDetail, row.u_detail, {});
  const newsType = newsTypeOrNull(cls.catalyst);
  // Bài tín hiệu luôn có loại tin hợp lệ; dữ liệu lạ thì không đoán, coi như không còn bài.
  if (newsType === null) return { item: null, remaining: 0 };
  return {
    item: {
      article: {
        id: a.id,
        title: (a.title ?? "").trim() === "" ? null : a.title,
        content: (a.content ?? "").trim() === "" ? null : a.content,
        url: a.url,
        source: a.source,
        tier: sourceTierOf(a.source, a.category),
        publishedAt: iso(a.publishedAt),
        tagged: parseOr(matchedList, a.matchedCurrencies, []).map((m) => m.symbol),
      },
      classification: {
        classifierVersion: a.claudePromptVersion,
        newsType,
        asset: ud.market ?? cls.market ?? null,
        relevance:
          cls.relevance === "direct"
            ? "direct"
            : cls.relevance === "passing_mention"
              ? "passingMention"
              : null,
        promotional: cls.promotional ?? null,
        eventDate: cls.eventDate ?? null,
        claude: usageOf(a),
      },
    },
    remaining: Number(row.remaining),
  };
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Cấp token gắn nhãn ngẫu nhiên cho bài `labels/next` vừa chọn (#348). Trả token thô (chỉ có trong response); DB chỉ giữ
 * sha256. Xoá luôn các token đã hết hạn quá 1 ngày (của mọi người) để bảng không phình.
 */
export async function issueLabelToken(
  db: Db,
  input: { userId: string; articleId: string; now: Date },
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.transaction(async (tx) => {
    await tx
      .delete(signalLabelTokens)
      .where(lt(signalLabelTokens.expiresAt, new Date(input.now.getTime() - 86_400_000)));
    await tx.insert(signalLabelTokens).values({
      tokenHash: hashToken(token),
      userId: input.userId,
      articleId: input.articleId,
      expiresAt: new Date(input.now.getTime() + LABEL_TOKEN_TTL_MIN * 60_000),
      createdAt: input.now,
    });
  });
  return token;
}

/** Dùng token (một lần): true khi đúng người, đúng bài, chưa hết hạn và chưa dùng. */
async function consumeLabelToken(
  tx: DbTx,
  input: { token: string; userId: string; articleId: string; now: Date },
): Promise<boolean> {
  const used = await tx
    .update(signalLabelTokens)
    .set({ usedAt: input.now })
    .where(
      and(
        eq(signalLabelTokens.tokenHash, hashToken(input.token)),
        eq(signalLabelTokens.userId, input.userId),
        eq(signalLabelTokens.articleId, input.articleId),
        isNull(signalLabelTokens.usedAt),
        gt(signalLabelTokens.expiresAt, input.now),
      ),
    )
    .returning({ id: signalLabelTokens.id });
  return used.length > 0;
}

const outcomeOf = (r: string | null): ResearchLabelTradeResult["outcome"] =>
  r === "take_profit"
    ? "tp"
    : r === "stop_loss"
      ? "sl"
      : r === "max_hold"
        ? "maxHold"
        : r === "max_hold_no_price"
          ? "maxHoldNoPrice"
          : r === "opposite_news"
            ? "opposite"
            : "open";

/** Kết quả các lệnh thật (live) bài này đã mở, mọi News bot version. Chỉ trả sau khi đã lưu nhãn. */
export async function loadLabelTradeResults(
  q: Exec,
  articleId: string,
): Promise<ResearchLabelTradeResult[]> {
  const rows = await q
    .select()
    .from(signalPaperTrades)
    .where(and(eq(signalPaperTrades.articleId, articleId), eq(signalPaperTrades.label, "live")))
    .orderBy(asc(signalPaperTrades.openedAt), asc(signalPaperTrades.id));
  return rows.map((t) => {
    const closed = t.status === "closed";
    return {
      tradeId: t.id,
      versionId: t.versionId,
      side: t.direction === "short" ? "short" : "long",
      status: closed ? "closed" : "open",
      outcome: closed ? outcomeOf(t.exitReason) : "open",
      resultPct:
        closed && t.resultPct !== null ? dec(t.resultPct).toDecimalPlaces(4).toNumber() : null,
      resultUsdc:
        closed && t.resultUsdc !== null ? dec(t.resultUsdc).toDecimalPlaces(6).toFixed() : null,
    };
  });
}

/**
 * Lưu (upsert) nhãn của một người cho một bài và ghi `audit_log`. Chỉ bài tín hiệu gắn nhãn được: bài không có → 404,
 * không phải tín hiệu → `STATE_CONFLICT` (`NOT_A_SIGNAL`). Body đã được API parse bằng zod (Wrong có lý do, Right không).
 */
export async function saveSignalClassificationLabel(
  db: Db,
  input: {
    articleId: string;
    userId: string;
    verdict: ClassificationVerdict;
    reason: ClassificationWrongReason | null;
    note: string | null;
    /** #348: token của `labels/next`; chỉ token hợp lệ mới cho nhãn `random`. */
    labelToken?: string | null;
    /** #423: role của người gọi lúc lưu (API quyết định); mặc định `team`. */
    labeler?: ClassificationLabeler;
    ip?: string | null;
    now?: Date;
  },
): Promise<ResearchLabelSaved> {
  const labeler = input.labeler ?? ClassificationLabeler.team;
  const now = input.now ?? new Date();
  const reason = input.verdict === "wrong" ? input.reason : null;
  const note = input.note === null || input.note.trim() === "" ? null : input.note.trim();
  return db.transaction(async (tx) => {
    const [exists] = await tx
      .select({ id: signalArticles.id })
      .from(signalArticles)
      .where(eq(signalArticles.id, input.articleId));
    if (exists === undefined) throw new AppError(ErrorCode.notFound, "Article not found.");
    const classifierVersion = await signalClassifierOf(tx, input.articleId);
    if (classifierVersion === null)
      throw new AppError(
        ErrorCode.stateConflict,
        "Only articles Claude called a signal can be labelled.",
        {
          reason: "NOT_A_SIGNAL",
        },
      );
    const before = await loadMyLabel(tx, input.articleId, input.userId);
    // Token chỉ được tiêu khi lần lưu này tạo nhãn mới; bài đã có nhãn của người này thì không thể "nâng" thành random.
    const tokenOk =
      before === null && input.labelToken != null
        ? await consumeLabelToken(tx, {
            token: input.labelToken,
            userId: input.userId,
            articleId: input.articleId,
            now,
          })
        : false;
    const source =
      tokenOk || (before?.source === "random" && before.verdict === input.verdict)
        ? ClassificationLabelSource.random
        : ClassificationLabelSource.trace;
    const [row] = await tx
      .insert(signalClassificationLabels)
      .values({
        articleId: input.articleId,
        classifierVersion,
        labeledBy: input.userId,
        verdict: input.verdict,
        reason,
        note,
        source,
        labeler,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [signalClassificationLabels.articleId, signalClassificationLabels.labeledBy],
        // Sửa nhãn ghi lại người chấm theo role lúc sửa (role đổi thì nhãn mới theo role mới).
        set: {
          classifierVersion,
          verdict: input.verdict,
          reason,
          note,
          source,
          labeler,
          updatedAt: now,
        },
      })
      .returning();
    if (row === undefined) throw new AppError(ErrorCode.internal, "Label not saved.");
    await tx.insert(auditLog).values({
      userId: input.userId,
      action: SignalLabelAudit.saved,
      target: input.articleId,
      // Không ghi nội dung ghi chú vào audit, chỉ có hay không.
      metadata: {
        classifierVersion,
        verdict: input.verdict,
        reason,
        hasNote: note !== null,
        source,
        labeler,
        // Có gửi token mà không được nhận (sai / hết hạn / đã dùng / bài đã có nhãn): để soi khi cần.
        tokenRejected: input.labelToken != null && !tokenOk,
        previous:
          before === null
            ? null
            : { verdict: before.verdict, reason: before.reason, source: before.source },
      },
      ip: input.ip ?? null,
    });
    return {
      articleId: input.articleId,
      label: labelOut(row),
      trades: await loadLabelTradeResults(tx, input.articleId),
    };
  });
}

/**
 * Số bài có nhãn `random` và số bài kết luận Right, theo classifier (đa số trong các nhãn random; hoà tính Wrong). Nhãn
 * `trace` không bao giờ vào đây (#348).
 */
async function labelTallies(q: Exec): Promise<Map<string, { labeled: number; right: number }>> {
  const r = await q.execute<{ v: string; r: string | number; w: string | number }>(sql`
    select classifier_version as v,
      count(*) filter (where verdict = 'right') as r,
      count(*) filter (where verdict = 'wrong') as w
    from signal_classification_labels
    where source = 'random' and labeler = 'team'
    group by classifier_version, article_id`);
  const out = new Map<string, { labeled: number; right: number }>();
  for (const x of r.rows) {
    const verdict = articleVerdict({ right: Number(x.r), wrong: Number(x.w) });
    if (verdict === null) continue;
    const cur = out.get(x.v) ?? { labeled: 0, right: 0 };
    cur.labeled += 1;
    if (verdict === "right") cur.right += 1;
    out.set(x.v, cur);
  }
  return out;
}

/** Cổng của mọi classifier đã có nhãn. Classifier không có trong map = chưa có nhãn (`classifierGate({0, 0})`). */
export async function loadClassifierGates(q: Exec): Promise<Map<string, ClassifierGate>> {
  const t = await labelTallies(q);
  return new Map([...t].map(([v, x]) => [v, classifierGate(x)]));
}

/** Trạng thái cổng của classifier đã tạo ra một lệnh. */
export function classifierStatusOf(
  gates: ReadonlyMap<string, ClassifierGate>,
  version: string | null,
): ClassifierGateStatus {
  if (version === null) return "unknown";
  return (gates.get(version) ?? classifierGate({ labeled: 0, right: 0 })).status;
}

/** Bảng chất lượng classifier (`GET /classifiers`). */
export async function loadSignalClassifiers(
  q: Q,
  check: () => void = () => undefined,
): Promise<ResearchClassifiers> {
  const tallies = await labelTallies(q);
  check();
  // Lý do sai: cả nhãn random lẫn trace (#348), chỉ nhãn team (#423).
  const mistakes = await q.execute<{ v: string; reason: string; n: string | number }>(sql`
    select classifier_version as v, reason, count(*) as n
    from signal_classification_labels where verdict = 'wrong' and labeler = 'team'
    group by classifier_version, reason`);
  check();
  const traced = await q.execute<{ v: string; n: string | number }>(sql`
    select classifier_version as v, count(distinct article_id) as n
    from signal_classification_labels where source = 'trace' and labeler = 'team'
    group by classifier_version`);
  check();
  // #423: nhãn tester theo bài (mọi nguồn), kèm phiếu `random` của team trên cùng bài (cùng tập nhãn với cổng; PM review
  // #428), để đối chiếu.
  const testerVotes = await q.execute<{
    v: string;
    tr: string | number;
    tw: string | number;
    sr: string | number;
    sw: string | number;
  }>(sql`
    select classifier_version as v,
      count(*) filter (where labeler = 'team' and source = 'random' and verdict = 'right') as tr,
      count(*) filter (where labeler = 'team' and source = 'random' and verdict = 'wrong') as tw,
      count(*) filter (where labeler = 'tester' and verdict = 'right') as sr,
      count(*) filter (where labeler = 'tester' and verdict = 'wrong') as sw
    from signal_classification_labels
    where article_id in (select article_id from signal_classification_labels where labeler = 'tester')
    group by classifier_version, article_id`);
  check();
  const testerByVersion = new Map<
    string,
    { team: { right: number; wrong: number }; tester: { right: number; wrong: number } }[]
  >();
  for (const x of testerVotes.rows) {
    const list = testerByVersion.get(x.v) ?? [];
    list.push({
      team: { right: Number(x.tr), wrong: Number(x.tw) },
      tester: { right: Number(x.sr), wrong: Number(x.sw) },
    });
    testerByVersion.set(x.v, list);
  }
  const signals = await q.execute<{ v: string; n: string | number }>(sql`
    select a.claude_prompt_version as v, count(*) as n from signal_articles a
    where ${IS_SIGNAL} group by a.claude_prompt_version`);
  check();
  // #395: lệnh thật đã đóng theo classifier, mọi rule version (lịch sử của reader đã retired).
  const closed = await q.execute<{ v: string; n: string | number }>(sql`
    select classifier_version as v, count(*) as n from signal_paper_trades
    where lane = 'news' and label = 'live' and status = 'closed' and classifier_version is not null
    group by classifier_version`);
  check();
  const started = await q.select().from(signalClassifierVersions);
  const startedAt = new Map(started.map((s) => [s.promptVersion, s.startedAt]));
  const signalsOf = new Map(signals.rows.map((s) => [s.v, Number(s.n)]));
  const tracedOf = new Map(traced.rows.map((s) => [s.v, Number(s.n)]));
  const closedOf = new Map(closed.rows.map((s) => [s.v, Number(s.n)]));
  const current = NEWS_CLASSIFIER.promptVersion;
  const versions = new Set<string>([
    current,
    ...startedAt.keys(),
    ...tallies.keys(),
    ...tracedOf.keys(),
    ...signalsOf.keys(),
  ]);
  const items = [...versions].map((v) => {
    const g = classifierGate(tallies.get(v) ?? { labeled: 0, right: 0 });
    const counts = new Map<ClassificationWrongReason, number>();
    for (const m of mistakes.rows) {
      const reason = reasonOf(m.reason);
      if (m.v === v && reason !== null) counts.set(reason, Number(m.n));
    }
    const at = startedAt.get(v);
    return {
      classifierVersion: v,
      current: v === current,
      startedAt: at === undefined ? null : iso(toDate(at)),
      signals: signalsOf.get(v) ?? 0,
      labeled: g.labeled,
      right: g.right,
      traceLabeled: tracedOf.get(v) ?? 0,
      closedTrades: closedOf.get(v) ?? 0,
      precisionPct: g.precisionPct,
      interval: g.interval,
      passes: g.passes,
      status: g.status,
      labelsToGo: g.labelsToGo,
      mostCommonMistakes: commonMistakes(counts),
      testers: testerAgreement(testerByVersion.get(v) ?? []),
    };
  });
  items.sort(
    (a, b) =>
      Number(b.current) - Number(a.current) ||
      (b.startedAt ?? "").localeCompare(a.startedAt ?? "") ||
      b.classifierVersion.localeCompare(a.classifierVersion),
  );
  return {
    gate: {
      minLabels: CLASSIFIER_GATE.minLabels,
      minPrecisionPct: CLASSIFIER_GATE.minPrecisionPct,
    },
    items,
  };
}
