import type {
  ResearchArticle,
  ResearchArticleTrace,
  ResearchClaudeUsage,
  ResearchDropReason,
  ResearchStage,
  ResearchTraceCheck,
  ResearchTraceStep,
} from "@drift/shared";

import { clock, count } from "../format";

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
            : t("trace.chip.traded", { side: t(`sides.${a.side}`), asset: a.asset }),
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
}

export type TraceEnd = "traded" | "drop" | "merge" | "waiting";

export interface TraceView {
  /** Bước cuối bài tới (1–5). */
  stop: number;
  end: TraceEnd;
  steps: StepView[];
  assets: string;
  /** Câu kết luận (không có phần chi phí Claude). */
  verdict: string;
  /** "Claude $0.0021" / "No Claude call" / "Claude cost not available". */
  cost: string;
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
  story: TraceStory;
  /** Tick size của market (danh sách market SoDEX); null khi chưa biết. */
  tickOf: (market: string) => string | null;
}

/**
 * Dựng toàn bộ phần trace (tầng, thẻ bước, câu kết luận) từ `/articles/:id/trace`. `tickOf` (tuỳ chọn): tick size của
 * market để hiện TP / SL đúng tick (#297).
 */
export function traceView(
  tr: ResearchArticleTrace,
  tz: string,
  t: Tr,
  tickOf: (market: string) => string | null = () => null,
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
  const steps: StepView[] = tr.steps.map((s) =>
    stepView(s, a, { market, story: story ?? null, tickOf }, tz, t),
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
    verdict = t("trace.verdict.reached", {
      why:
        d === null
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
  const c = claudeCost(a.sentToClaude, a.claude, t);
  const cost =
    c === null
      ? t("trace.verdict.claudeNa")
      : a.sentToClaude
        ? t("trace.verdict.claude", { cost: c })
        : c;
  return { stop: last + 1, end, steps, assets, verdict, cost };
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
              markets: story.market,
            });
      return { ...base, short, band, summary, rows };
    }
    case "score": {
      const d = s.detail;
      const u = d?.claude ?? a.claude;
      const cost = u?.costUsd ?? null;
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
        if (d.asset !== null) rows.push({ label: t("trace.rows.asset"), value: d.asset });
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
      if (a.sentToClaude || u !== null) rows.push(...claudeRows(u, t));
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
      return { ...base, short, band: band ?? short, summary, rows };
    }
    case "decide": {
      const d = s.detail;
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
