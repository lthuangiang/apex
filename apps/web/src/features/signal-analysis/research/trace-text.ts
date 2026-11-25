import type {
  ResearchArticle,
  ResearchArticleTrace,
  ResearchClaudeUsage,
  ResearchDropReason,
  ResearchStage,
  ResearchTraceCheck,
  ResearchTraceEvent,
  ResearchTraceEventCoin,
  ResearchTraceStep,
} from "@drift/shared";

import { clock, count, day, monthDay } from "../format";

import {
  delay,
  delayLong,
  hold,
  pctPlain,
  pctSigned,
  priceText,
  tickPrice,
  usdSigned,
} from "./format";
import type { Tr } from "./text";

// Câu chữ của News feed và trace một bài (#292, thiết kế docs/mockups/signal-research/news-trace.html). Hàm thuần: chỉ
// dựng câu từ dữ liệu API (#291) trả về; thiếu thì trả `null` và component hiện "Not available" (quy tắc 1.8).

export const STAGES: readonly ResearchStage[] = [
  "collect",
  "normalize",
  "score",
  "filter",
  "decide",
] as const;

/** Chi phí Claude của một bài: "$0.0021" (4 chữ số như thiết kế). */
export const usd4 = (v: string): string => `$${Number(v).toFixed(4)}`;

/** "$0.0021" / "No Claude call" / null (đã gửi Claude mà không có chi phí). */
export function claudeCost(sent: boolean, usage: ResearchClaudeUsage | null, t: Tr): string | null {
  if (!sent) return t("trace.noClaude");
  const c = usage?.costUsd ?? null;
  return c === null ? null : usd4(c);
}
const claudeCostText = claudeCost;

export function assetsText(a: ResearchArticle, t: Tr): string {
  return a.tagged.length === 0 ? t("trace.noCoin") : a.tagged.join(", ");
}

export function articleTitle(a: ResearchArticle): string | null {
  return a.title ?? a.excerpt;
}

export type ChipTone = "pos" | "neg" | "neutral" | "accent";

/** Nhãn kết quả trên thẻ bài: "Long ETH · paper trade" / "Dropped at Score"… */
export function reached(a: ResearchArticle, t: Tr): { text: string; tone: ChipTone } {
  const stage = t(`trace.stages.${a.stage}`);
  switch (a.outcome) {
    case "traded":
      return {
        text:
          a.side === null || a.asset === null
            ? t("trace.chip.tradedNoAsset")
            : t("trace.chip.traded", {
                side: t(`sides.${a.side}`),
                // #530: sự kiện nhiều coin mở nhiều lệnh: liệt kê mọi coin đã vào lệnh ("Long AAVE, LINK · paper trade").
                asset: a.tradedAssets?.join(", ") ?? a.asset,
              }),
        tone: "pos",
      };
    case "dropped":
      // #343: "Dropped at …" luôn xám; xanh lá chỉ cho lệnh đã vào, đỏ chỉ cho lỗ / lỗi.
      return { text: t("trace.chip.dropped", { stage }), tone: "neutral" };
    case "merged":
      // Gộp vào câu chuyện đã có không phải bị loại: màu trung tính.
      return { text: t("trace.chip.merged"), tone: "neutral" };
    case "waiting":
      return { text: t("trace.chip.waiting", { stage }), tone: "neutral" };
  }
}

export interface Row {
  label: string;
  /** null = "Not available". */
  value: string | null;
  /** Mã nội bộ (chỉ ở tooltip, không bao giờ in ra thẻ). */
  title?: string | undefined;
}

export type StepStatus = ResearchTraceStep["status"];

export interface StepView {
  key: ResearchStage;
  status: StepStatus;
  /** Một dòng kết quả của bước. */
  short: string;
  /**
   * #343: kết quả gọn trên tầng phễu sáng ("ETH-USD · new story", "ETF approved → Long", "4 of 4 checks"); không cắt
   * "…", không vừa thì xuống 2 dòng.
   */
  band: string;
  summary: string;
  rows: Row[];
  /** #530: nhóm dòng theo từng coin của sự kiện nhiều coin (Filter / Decide), sau `rows`. */
  groups?: { title: string; rows: Row[] }[];
  /** #530: dòng nhấn mạnh dưới tóm tắt ("Size split across {n} coins from one event."). */
  note?: string;
}

export type TraceEnd = "traded" | "drop" | "merge" | "waiting";

export interface TraceView {
  /** Bước cuối bài tới (1–5). */
  stop: number;
  end: TraceEnd;
  steps: StepView[];
  assets: string;
  /** Coin của chip đã vào lệnh trong phễu: sự kiện nhiều coin → mọi coin đã vào lệnh (#530), không thì `assets`. */
  tradedAssets: string;
  /** Câu kết luận (không có phần chi phí Claude). */
  verdict: string;
  /**
   * "Claude $0.0021" / "No Claude call" / "Claude cost not available"; null khi người xem không thấy chi phí Claude
   * (người dùng test, #423).
   */
  cost: string | null;
}

const PCT_NA = (v: number | null, f: (n: number) => string): string | null =>
  v === null ? null : f(v);

/**
 * "Result: Dropped: Not on SoDEX": cùng câu với "Why they dropped out". Mã nội bộ (`NO_SODEX_MARKET`…) không in ra thẻ, chỉ
 * ở tooltip (#343 review).
 */
function droppedRow(s: ResearchTraceStep, t: Tr): Row {
  const r: ResearchDropReason | null = s.reason;
  return {
    label: t("trace.rows.result"),
    value:
      r !== null
        ? t("trace.values.dropped", { code: t(`trace.reasonLabels.${r}`) })
        : s.code !== null
          ? t("trace.status.drop")
          : null,
    title: s.code ?? undefined,
  };
}

function claudeRows(u: ResearchClaudeUsage | null, t: Tr): Row[] {
  const tk = u?.tokens ?? null;
  const tokens =
    tk === null
      ? null
      : tk.cacheWrite > 0
        ? t("trace.values.tokensWrite", {
            input: count(tk.input),
            cacheWrite: count(tk.cacheWrite),
            cacheRead: count(tk.cacheRead),
            output: count(tk.output),
          })
        : t("trace.values.tokens", {
            input: count(tk.input),
            cacheRead: count(tk.cacheRead),
            output: count(tk.output),
          });
  const c = u?.costUsd ?? null;
  const model = u?.model ?? null;
  const cost =
    c === null
      ? null
      : model === null
        ? usd4(c)
        : t("trace.values.costModel", { cost: usd4(c), model });
  return [
    { label: t("trace.rows.tokens"), value: tokens },
    { label: t("trace.rows.claudeCost"), value: cost },
  ];
}

function checkRow(c: ResearchTraceCheck, asset: string, t: Tr): Row {
  const label = t(`trace.rows.checks.${c.key}`, { asset });
  switch (c.key) {
    case "sourceLive":
      return {
        label,
        value:
          c.value === null || c.limit === null
            ? null
            : t("trace.values.sourceLive", {
                value: String(Math.round(c.value)),
                limit: String(Math.round(c.limit)),
              }),
      };
    case "priceAvailable":
      return {
        label,
        value: !c.ok
          ? t("trace.values.priceFail")
          : c.spreadPct === null
            ? t("trace.values.priceOk")
            : t("trace.values.priceSpread", { spread: `${(c.spreadPct * 100).toFixed(1)} bp` }),
      };
    case "noOpenTrade":
      return { label, value: c.ok ? t("trace.values.openNone") : t("trace.values.openYes") };
    case "tpVsCost": {
      if (c.value === null || c.costPct === null) return { label, value: null };
      if (c.ok)
        return {
          label,
          value: t("trace.values.tpOk", { tp: pctPlain(c.value), cost: pctPlain(c.costPct) }),
        };
      return {
        label,
        value:
          c.limit === null
            ? null
            : t("trace.values.tpFail", {
                tp: pctPlain(c.value),
                cost: pctPlain(c.costPct),
                limit: pctPlain(c.limit),
              }),
      };
    }
  }
}

type TraceStory = Extract<ResearchTraceStep, { key: "normalize" }>["detail"] extends infer D
  ? D extends { story: infer S }
    ? S
    : never
  : never;

interface StepCtx {
  market: string;
  /** #530: sự kiện nhiều coin / bài đăng lại của sự kiện; null = bài một coin. */
  event: ResearchTraceEvent | null;
  story: TraceStory;
  /** Tick size của market (danh sách market SoDEX); null khi chưa biết. */
  tickOf: (market: string) => string | null;
  /** #423: false = người dùng test, không có token / chi phí Claude trên thẻ Score. */
  claudeCost: boolean;
}

/** #530: sự kiện có từ hai coin trở lên (thẻ Filter / Decide / Context theo từng coin). */
const multiCoin = (e: ResearchTraceEvent | null): e is ResearchTraceEvent =>
  e !== null && e.items.length >= 2;

/** Giờ của bài đầu cho dòng "First article": thêm ngày khi khác ngày với bài đang xem (theo múi giờ người xem). */
function firstArticleTime(at: string, articleAt: string, tz: string): string {
  const time = clock(at, tz, false);
  return day(at, tz) === day(articleAt, tz) ? time : `${monthDay(at, tz)} ${time}`;
}

/** Dòng "First article" của bài đăng lại khi có coin dừng với `sameEvent`; null khi không có. */
function firstArticleRow(
  e: ResearchTraceEvent | null,
  a: ResearchArticle,
  tz: string,
  t: Tr,
): Row | null {
  const f = e?.firstArticle ?? null;
  if (f === null) return null;
  return {
    label: t("trace.rows.firstArticle"),
    value: t("trace.values.duplicateOf", {
      title: f.title ?? f.excerpt ?? t("na"),
      time: firstArticleTime(f.publishedAt, a.publishedAt, tz),
    }),
  };
}

/** Dòng kết quả của một coin (bị loại / gộp); null khi coin vào lệnh hoặc còn chờ. */
function coinResultRow(c: ResearchTraceEventCoin, t: Tr): Row | null {
  if (c.outcome === "dropped")
    return {
      label: t("trace.rows.result"),
      value:
        c.reason === null
          ? t("trace.status.drop")
          : t("trace.values.dropped", { code: t(`trace.reasonLabels.${c.reason}`) }),
      title: c.code ?? undefined,
    };
  if (c.outcome === "merged")
    return {
      label: t("trace.rows.result"),
      value:
        c.mergeReason === null
          ? t("trace.status.merge")
          : t("trace.values.merged", { why: t(`trace.why.${c.mergeReason}`) }),
      title: c.code ?? undefined,
    };
  return null;
}

/** Nhóm dòng của thẻ Filter theo từng coin: các kiểm, giờ bắt đầu câu chuyện (gộp quá cũ), kết quả. */
function filterGroups(e: ResearchTraceEvent, tz: string, t: Tr): { title: string; rows: Row[] }[] {
  return e.items.map((c) => {
    const rows = c.checks.map((x) => checkRow(x, c.market, t));
    if (c.storyStartedAt !== null)
      rows.push({ label: t("trace.rows.storyStarted"), value: clock(c.storyStartedAt, tz, false) });
    const r = coinResultRow(c, t);
    if (r !== null) rows.push(r);
    return { title: c.market, rows };
  });
}

/** Lệnh đã vào của sự kiện, theo thứ tự coin. */
const tradesOf = (e: ResearchTraceEvent) =>
  e.items.flatMap((c) => (c.trade === null ? [] : [{ market: c.market, trade: c.trade }]));

/**
 * Dựng toàn bộ phần trace (tầng, thẻ bước, câu kết luận) từ `/articles/:id/trace`. `tickOf` (tuỳ chọn): tick size của
 * market để hiện TP / SL đúng tick (#297).
 */
export function traceView(
  tr: ResearchArticleTrace,
  tz: string,
  t: Tr,
  tickOf: (market: string) => string | null = () => null,
  /** #423: false = người dùng test (trang Signal Research BETA): bỏ mọi dòng chi phí / token Claude. */
  claudeCost = true,
): TraceView {
  const a = tr.article;
  const assets = assetsText(a, t);
  const na = t("na");
  const [, normalize, score, , decide] = tr.steps;
  const story = normalize?.key === "normalize" ? (normalize.detail?.story ?? null) : null;
  const market =
    story?.market ??
    a.asset ??
    (normalize?.key === "normalize" ? normalize.detail?.candidates[0]?.market : undefined) ??
    assets;
  const event = tr.event ?? null;
  const steps: StepView[] = tr.steps.map((s) =>
    stepView(s, a, { market, event, story: story ?? null, tickOf, claudeCost }, tz, t),
  );
  let last = 0;
  tr.steps.forEach((s, i) => {
    if (s.status !== "notReached") last = i;
  });
  const lastStep = tr.steps[last];
  const end: TraceEnd =
    lastStep?.status === "drop"
      ? "drop"
      : lastStep?.status === "merge"
        ? "merge"
        : a.outcome === "traded"
          ? "traded"
          : "waiting";
  const stageName = t(`trace.stages.${STAGES[last] ?? "collect"}`);
  let verdict: string;
  if (end === "drop") {
    const r = lastStep?.reason ?? a.reason;
    const mention =
      score?.key === "score" && score.detail?.relevance === "passingMention" && r === "notCatalyst";
    const why =
      r === null
        ? na
        : mention
          ? t("trace.why.notCatalystMention")
          : r === "notOnSodex"
            ? t("trace.why.notOnSodex", { assets, n: a.tagged.length })
            : t(`trace.why.${r}`);
    verdict = t("trace.verdict.stopped", { stage: stageName, why });
  } else if (end === "merge") {
    const m = lastStep?.mergeReason ?? a.mergeReason;
    verdict = t("trace.verdict.merged", {
      stage: stageName,
      why: m === null ? na : t(`trace.why.${m}`),
    });
  } else if (end === "traded") {
    const d = decide?.key === "decide" ? decide.detail : null;
    const many = multiCoin(event) ? tradesOf(event) : [];
    verdict = t("trace.verdict.reached", {
      why:
        many.length > 0
          ? // #530: một câu cho mỗi lệnh của sự kiện nhiều coin, nối bằng " · ".
            many
              .map((x) =>
                t("trace.why.traded", {
                  side: t(`sides.${x.trade.side}`),
                  market: x.market,
                  size: count(Number(x.trade.sizeUsdc)),
                }),
              )
              .join(t("trades.sep"))
          : d === null
            ? na
            : t("trace.why.traded", {
                side: t(`sides.${d.side}`),
                market,
                size: count(Number(d.sizeUsdc)),
              }),
    });
  } else {
    verdict = t("trace.verdict.waiting", { stage: stageName });
  }
  const c = claudeCost ? claudeCostText(a.sentToClaude, a.claude, t) : null;
  const cost = !claudeCost
    ? null
    : c === null
      ? t("trace.verdict.claudeNa")
      : a.sentToClaude
        ? t("trace.verdict.claude", { cost: c })
        : c;
  const tradedAssets =
    a.tradedAssets !== undefined && a.tradedAssets.length > 0 ? a.tradedAssets.join(", ") : assets;
  return { stop: last + 1, end, steps, assets, tradedAssets, verdict, cost };
}

function stepView(
  s: ResearchTraceStep,
  a: ResearchArticle,
  ctx: StepCtx,
  tz: string,
  t: Tr,
): StepView {
  const { market } = ctx;
  const sep = t("trades.sep");
  const base = { key: s.key, status: s.status };
  const drop = s.status === "drop";
  switch (s.key) {
    case "collect": {
      const d = s.detail;
      const noCoin = drop || d.tagged.length === 0;
      const rows: Row[] = [
        { label: t("trace.rows.published"), value: clock(d.publishedAt, tz) },
        {
          label: t("trace.rows.collected"),
          value: t("trace.values.collected", {
            time: clock(d.collectedAt, tz),
            d: delayLong(d.delaySecs),
          }),
        },
        {
          label: t("trace.rows.source"),
          value:
            d.tier === null
              ? d.source
              : t("trace.values.sourceTier", {
                  source: d.source,
                  tier: t(`trace.tiers.${d.tier}`),
                }),
        },
        {
          label: t("trace.rows.tags"),
          value:
            d.tagged.length === 0
              ? t("trace.values.none")
              : d.tagged
                  .map((x) =>
                    x.name === null
                      ? x.symbol
                      : t("trace.values.tag", { name: x.name, symbol: x.symbol }),
                  )
                  .join(", "),
        },
      ];
      if (drop) rows.push(droppedRow(s, t));
      const collectShort =
        drop && noCoin ? t("trace.short.noCoin") : t("trace.short.seen", { d: delay(d.delaySecs) });
      return {
        ...base,
        short: collectShort,
        band: collectShort,
        summary: drop && noCoin ? t("trace.summary.collectNoCoin") : t("trace.summary.collect"),
        rows,
      };
    }
    case "normalize": {
      const d = s.detail;
      const cands = d?.candidates ?? [];
      const markets =
        cands.length === 1 && cands[0] !== undefined
          ? t("trace.short.pair", { symbol: cands[0].symbol, market: cands[0].market })
          : cands.map((c) => c.market).join(", ");
      const story = d?.story ?? null;
      const dup = d?.duplicateOf ?? null;
      const rows: Row[] = [];
      let short: string;
      let summary: string;
      if (drop && s.reason === "duplicate") {
        short =
          dup === null
            ? t("trace.short.duplicate")
            : t("trace.short.duplicateOf", { time: clock(dup.publishedAt, tz, false) });
        summary = t("trace.summary.duplicate");
        rows.push({
          label: t("trace.rows.duplicateOf"),
          value:
            dup === null
              ? null
              : t("trace.values.duplicateOf", {
                  title: dup.title ?? dup.excerpt ?? t("na"),
                  time: clock(dup.publishedAt, tz, false),
                }),
        });
      } else if (drop) {
        const assets = assetsText(a, t);
        short =
          s.reason === "notOnSodex"
            ? t("trace.short.notOnSodex", { assets })
            : s.reason === null
              ? t("trace.status.drop")
              : t(`trace.reasonLabels.${s.reason}`);
        summary =
          s.reason === "notOnSodex"
            ? t("trace.summary.notOnSodex", { assets })
            : t("trace.summary.dropped", {
                reason: s.reason === null ? t("na") : t(`trace.reasonLabels.${s.reason}`),
              });
        rows.push({ label: t("trace.rows.candidates"), value: t("trace.values.none") });
      } else {
        short =
          story === null
            ? markets
            : t(story.isNew ? "trace.short.newStory" : "trace.short.sameStory", { markets });
        summary =
          story === null
            ? t("trace.summary.normalize")
            : story.isNew
              ? t("trace.summary.normalizeNew")
              : t("trace.summary.normalizeSame");
        rows.push({
          label: t("trace.rows.candidates"),
          value:
            cands.length === 0 ? t("trace.values.none") : cands.map((c) => c.market).join(", "),
        });
        if (story !== null) {
          rows.push({
            label: t("trace.rows.story"),
            value: t(story.isNew ? "trace.values.storyNew" : "trace.values.storySame", {
              type: t(`trades.newsTypes.${story.newsType}`),
              market: story.market,
            }),
          });
          rows.push({ label: t("trace.rows.storySources"), value: count(story.sources) });
        }
      }
      if (drop) rows.push(droppedRow(s, t));
      const marketList = cands.map((c) => c.market).join(", ");
      const band =
        drop || story === null
          ? drop
            ? short
            : marketList
          : t(story.isNew ? "trace.short.newStory" : "trace.short.sameStory", {
              // #530: sự kiện nhiều coin liệt kê mọi market ứng viên (Normalize đứng trước Filter, chưa biết coin nào qua).
              markets: ctx.event !== null && cands.length >= 2 ? marketList : story.market,
            });
      return { ...base, short, band, summary, rows };
    }
    case "score": {
      const d = s.detail;
      const u = d?.claude ?? a.claude;
      const cost = ctx.claudeCost ? (u?.costUsd ?? null) : null;
      const parts: string[] = [];
      let summary: string;
      if (drop) {
        parts.push(
          s.reason === "notCatalyst"
            ? t("trace.short.noType")
            : s.reason === "promotional"
              ? t("trace.short.promotional")
              : s.reason === null
                ? t("trace.status.drop")
                : t(`trace.reasonLabels.${s.reason}`),
        );
        summary =
          s.reason === "notCatalyst" || s.reason === "promotional" || s.reason === "notUnderstood"
            ? t(`trace.summary.${s.reason}`)
            : t("trace.summary.dropped", {
                reason: s.reason === null ? t("na") : t(`trace.reasonLabels.${s.reason}`),
              });
      } else {
        if (d?.newsType != null)
          parts.push(
            d.side === null
              ? t(`trades.newsTypes.${d.newsType}`)
              : t("trace.short.typeSide", {
                  type: t(`trades.newsTypes.${d.newsType}`),
                  side: t(`sides.${d.side}`),
                }),
          );
        if (d?.level != null) parts.push(t(`levels.${d.level}`));
        summary = t("trace.summary.score");
      }
      // Tầng phễu: chỉ loại tin → chiều (hoặc lý do bị loại), không mức / chi phí.
      const band = parts[0] ?? "";
      if (cost !== null) parts.push(usd4(cost));
      const rows: Row[] = [];
      if (d !== null) {
        rows.push({
          label: t("trace.rows.newsType"),
          value:
            d.newsType === null
              ? t("trace.values.none")
              : d.side === null
                ? t(`trades.newsTypes.${d.newsType}`)
                : t("trace.short.typeSide", {
                    type: t(`trades.newsTypes.${d.newsType}`),
                    side: t(`sides.${d.side}`),
                  }),
        });
        if (multiCoin(ctx.event))
          rows.push({
            label: t("trace.rows.asset"),
            value: ctx.event.items.map((c) => c.market).join(", "),
          });
        else if (d.asset !== null) rows.push({ label: t("trace.rows.asset"), value: d.asset });
        if (d.relevance !== null)
          rows.push({ label: t("trace.rows.relevance"), value: t(`trace.values.${d.relevance}`) });
        if (d.promotional !== null)
          rows.push({
            label: t("trace.rows.promotional"),
            value: d.promotional ? t("trace.values.yes") : t("trace.values.no"),
          });
        // #297: mức khoá lúc vào lệnh; câu chuyện có thêm nguồn sau đó → "Low at entry · now 2 sources" để khỏi tưởng
        // mâu thuẫn với "Sources in story".
        const entrySources =
          d.levelSources === null
            ? null
            : new Set(d.levelSources.map((x) => x.name.toLowerCase())).size;
        const now = ctx.story?.sources ?? null;
        if (d.level !== null)
          rows.push({
            label: t("trace.rows.level"),
            value:
              now !== null && entrySources !== null && now > entrySources
                ? t("trace.values.levelNow", { level: t(`levels.${d.level}`), n: now })
                : d.levelSources === null || d.levelSources.length === 0
                  ? t(`levels.${d.level}`)
                  : t("trace.values.level", {
                      level: t(`levels.${d.level}`),
                      sources: d.levelSources
                        .map((x) =>
                          t("trace.values.levelSource", {
                            name: x.name,
                            tier: t(`trace.tiers.${x.tier}`),
                          }),
                        )
                        .join(", "),
                    }),
          });
        // Mã lỗi của Claude chỉ ở tooltip; thẻ ghi "Not understood".
        if (d.error !== null)
          rows.push({
            label: t("trace.rows.claudeError"),
            value: t("trace.reasonLabels.notUnderstood"),
            title: d.error,
          });
      }
      if (drop) rows.push(droppedRow(s, t));
      if (ctx.claudeCost && (a.sentToClaude || u !== null)) rows.push(...claudeRows(u, t));
      return { ...base, short: parts.join(sep), band, summary, rows };
    }
    case "filter": {
      const d = s.detail;
      const checks = d?.checks ?? [];
      const rows: Row[] = checks.map((c) => checkRow(c, market, t));
      let short: string;
      let band: string | null = null;
      let summary: string;
      if (s.status === "merge") {
        short = t("trace.short.merged");
        band = t("trace.status.merge");
        summary =
          s.mergeReason === "storyTooOld"
            ? t("trace.summary.mergedTooOld")
            : t("trace.summary.merged");
        if (d?.laterLevel != null)
          rows.push({ label: t("trace.rows.storyLevel"), value: t(`levels.${d.laterLevel}`) });
        if (d?.storyStartedAt != null)
          rows.push({
            label: t("trace.rows.storyStarted"),
            value: clock(d.storyStartedAt, tz, false),
          });
        rows.push({
          label: t("trace.rows.result"),
          value:
            s.mergeReason === null
              ? null
              : t("trace.values.merged", { why: t(`trace.why.${s.mergeReason}`) }),
        });
      } else if (drop) {
        const tp = checks.find((c) => c.key === "tpVsCost");
        short =
          s.reason === "tpUnderCost" && tp !== undefined && tp.value !== null
            ? t("trace.short.tpUnderCost", { tp: pctPlain(tp.value) })
            : s.reason === null
              ? t("trace.status.drop")
              : t(`trace.reasonLabels.${s.reason}`);
        summary =
          s.reason === "tpUnderCost"
            ? t("trace.summary.tpUnderCost")
            : s.reason === "sameEvent"
              ? t("trace.summary.sameEvent")
              : s.reason === "belowMinSize"
                ? t("trace.summary.belowMinSize")
                : t("trace.summary.dropped", {
                    reason: s.reason === null ? t("na") : t(`trace.reasonLabels.${s.reason}`),
                  });
        rows.push(droppedRow(s, t));
        // #306: bài là tin ngược chiều trên lệnh đang mở (đóng hay giữ lệnh đó); tín hiệu bị giới hạn chặn vẫn được
        // theo dõi giả định (shadow).
        if (d?.opposite != null)
          rows.push({
            label: t("trace.rows.oppositeArticle"),
            value: t("trace.values.oppositeArticle", { action: d.opposite.action }),
          });
        if (d?.shadowTradeId != null)
          rows.push({ label: t("trace.rows.shadow"), value: t("trace.values.shadow") });
      } else {
        const passed = checks.filter((c) => c.ok).length;
        short = t("trace.short.checks", { passed, total: checks.length });
        band = t("trace.bandShort.checks", { passed, total: checks.length });
        summary = t("trace.summary.filter");
      }
      // #530: bài đăng lại có coin dừng với "Same event" → dòng "First article" (bài đầu của sự kiện) lên đầu.
      const ev = ctx.event;
      const same =
        s.reason === "sameEvent" || (ev?.items.some((c) => c.reason === "sameEvent") ?? false);
      const first = same && s.status !== "notReached" ? firstArticleRow(ev, a, tz, t) : null;
      if (multiCoin(ev) && s.status !== "notReached") {
        // Sự kiện nhiều coin: kết quả từng coin trong nhóm riêng; bước dừng của cả bài vẫn theo coin bài nêu trước.
        if (s.status === "pass") {
          band = t("trace.bandShort.coins", {
            passed: ev.items.filter((c) => c.outcome === "traded").length,
            n: ev.items.length,
          });
          short = band;
          summary = t("trace.summary.filterEach");
        }
        return {
          ...base,
          short,
          band: band ?? short,
          summary,
          rows: first === null ? [] : [first],
          groups: filterGroups(ev, tz, t),
        };
      }
      return {
        ...base,
        short,
        band: band ?? short,
        summary,
        rows: first === null ? rows : [first, ...rows],
      };
    }
    case "decide": {
      const d = s.detail;
      const ev = ctx.event;
      // #530: sự kiện nhiều coin → một dòng mỗi coin (vào lệnh / bị loại / gộp) và câu chia cỡ lệnh.
      if (multiCoin(ev) && s.status === "pass") {
        const many = tradesOf(ev);
        const head = many[0];
        if (head !== undefined) {
          const side = t(`sides.${head.trade.side}`);
          const size = count(Number(head.trade.sizeUsdc));
          return {
            ...base,
            short: many
              .map((x) =>
                t("trace.short.trade", {
                  side: t(`sides.${x.trade.side}`),
                  market: x.market,
                  size: count(Number(x.trade.sizeUsdc)),
                }),
              )
              .join(sep),
            band:
              many.length >= 2
                ? t("trace.bandShort.tradeMany", { side, size, n: many.length })
                : t("trace.bandShort.trade", { side, size }),
            summary: many.length >= 2 ? t("trace.summary.decideMany") : t("trace.summary.decide"),
            ...(ev.coins >= 2 ? { note: t("trace.summary.eventSplit", { n: ev.coins }) } : {}),
            rows: ev.items.map((c) => ({
              label: c.market,
              value:
                c.trade !== null
                  ? t("trace.short.trade", {
                      side: t(`sides.${c.trade.side}`),
                      market: c.market,
                      size: count(Number(c.trade.sizeUsdc)),
                    })
                  : (coinResultRow(c, t)?.value ?? t("na")),
              title: c.code ?? undefined,
            })),
          };
        }
      }
      if (d === null)
        return {
          ...base,
          short: s.status === "notReached" ? "" : t("na"),
          band: s.status === "notReached" ? "" : t("na"),
          summary: "",
          rows: [],
        };
      const side = t(`sides.${d.side}`);
      const size = count(Number(d.sizeUsdc));
      return {
        ...base,
        short: t("trace.short.trade", { side, market, size }),
        band: t("trace.bandShort.trade", { side, size }),
        summary: t("trace.summary.decide"),
        // #530: lần thử lại một coin của sự kiện nhiều coin vẫn là phần chia của sự kiện.
        ...(ev !== null && ev.coins >= 2
          ? { note: t("trace.summary.eventSplit", { n: ev.coins }) }
          : {}),
        rows: [
          { label: t("trace.rows.side"), value: t("trace.values.sideMarket", { side, market }) },
          { label: t("trace.rows.size"), value: t("trace.values.size", { size }) },
          {
            label: t("trace.rows.entry"),
            value: t("trace.values.entry", {
              price: priceText(d.entry),
              time: clock(d.openedAt, tz),
            }),
          },
          {
            label: t("trace.rows.tpSl"),
            value: t("trace.values.tpSl", {
              tp: tickPrice(d.tp, ctx.tickOf(market), d.entry),
              tpPct: PCT_NA(d.tpPct, (v) => pctSigned(v, 1)) ?? t("na"),
              sl: tickPrice(d.sl, ctx.tickOf(market), d.entry),
              slPct: PCT_NA(d.slPct, (v) => pctSigned(v, 1)) ?? t("na"),
            }),
          },
          { label: t("trace.rows.maxHold"), value: hold(d.maxHoldHours) },
          // #306: tin ngược chiều lúc lệnh đang mở; kết quả là kết quả giả định nếu đóng lúc đó (DEC-337 mục 9).
          ...(d.opposite === null
            ? []
            : [
                {
                  label: t("trace.rows.opposite"),
                  value: t("trace.values.opposite", {
                    time: clock(d.opposite.at, tz, false),
                    action: d.opposite.action,
                    usd: usdSigned(d.opposite.resultUsdc),
                    pct: pctSigned(d.opposite.resultPct),
                  }),
                },
              ]),
        ],
      };
    }
  }
}
