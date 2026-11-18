"use client";

import type { ResearchFact, ResearchStep, ResearchTradeDetail as Detail } from "@drift/shared";
import { BottomSheet, Skeleton } from "@drift/ui";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import type { PageCtx } from "../components/signal-analysis-page";
import { clock, count, monthDay, shortDate, signed } from "../format";

import { useResearchTrade } from "./api";
import {
  delay,
  hold,
  pctPlain,
  pctSigned,
  priceText,
  span,
  times,
  tone,
  usdCompact,
  usdPlain,
  usdSigned,
} from "./format";
import { skipText, tradeTitle } from "./text";
import { Na, Pill, RetryTag, SIDE_TONE } from "./ui";

// Một lệnh của Signal research: các bước nó đã đi qua (mockup signal-research/trade.html): Received → Understood →
// Scored → Checks → Trade → Result. Mọi số từ API; ô thiếu là "Not available".

type FactKey = ResearchFact["key"];
type Field = Exclude<keyof ResearchFact, "key">;

/** Trường bắt buộc của từng ô: thiếu một trường là cả ô "Not available" (quy tắc 1.8). */
const REQUIRED: Record<FactKey, readonly Field[]> = {
  whaleFill: ["at"],
  seen: ["at", "secs"],
  published: ["at"],
  collected: ["at", "secs"],
  source: ["source"],
  sourceHealth: ["status"],
  action: ["side"],
  whaleSize: ["usd", "x"],
  market: ["text"],
  walletQuality: ["n", "pct"],
  newsType: ["newsType"],
  direction: ["side"],
  eventDate: [],
  levelAtEntry: ["level", "n"],
  laterLevel: ["level", "n"],
  fundingRate: ["pct", "hours"],
  entry: ["price"],
  size: ["usd"],
  tp: ["price", "pct"],
  sl: ["price", "pct"],
  maxHold: ["hours"],
  exit: ["price", "at", "outcome"],
  priceMove: ["pct", "usd"],
  movedBeforeEntry: ["pct"],
  fees: ["usd"],
  best: ["pct"],
  worst: ["pct"],
  random: ["pct"],
  whaleFillPrice: ["price", "pct"],
};

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const given = <T,>(v: T | null | undefined): v is T => v !== null && v !== undefined;

function FactValue({ f, tz }: { f: ResearchFact; tz: string }) {
  const t = useTranslations("signalAnalysis.research");
  // #278: lane News gửi tên nguồn của bài (CoinDesk…) trong `text`, không có chu kỳ đồng bộ.
  if (f.key === "source" && !given(f.secs))
    return given(f.text) && f.text !== "" ? <>{f.text}</> : <Na />;
  // #278: ngày sự kiện là "YYYY-MM-DD" trong `text` (chỉ ngày, không đổi múi giờ).
  if (f.key === "eventDate") {
    if (given(f.at)) return <>{monthDay(f.at, tz)}</>;
    return given(f.text) && YMD.test(f.text) ? <>{shortDate(f.text)}</> : <Na />;
  }
  if (REQUIRED[f.key].some((k) => !given(f[k]))) return <Na />;
  const pct =
    f.pct === null || f.pct === undefined
      ? ""
      : f.key === "walletQuality"
        ? String(Math.round(f.pct))
        : f.key === "whaleFillPrice"
          ? pctPlain(Math.abs(f.pct))
          : f.key === "tp" || f.key === "sl" || f.key === "movedBeforeEntry"
            ? pctSigned(f.pct, 1)
            : pctSigned(f.pct);
  const usd =
    f.usd === null || f.usd === undefined
      ? ""
      : f.key === "whaleSize"
        ? usdCompact(f.usd)
        : f.key === "size"
          ? count(Number(f.usd))
          : f.key === "fees"
            ? // `fees.usd` là chi phí dương (#278): hiện dấu trừ như mockup ("−$0.50").
              usdPlain(String(-Math.abs(Number(f.usd))))
            : usdPlain(f.usd);
  const values = {
    time: f.at === null || f.at === undefined ? "" : clock(f.at, tz),
    date: f.at === null || f.at === undefined ? "" : monthDay(f.at, tz),
    delay: f.secs === null || f.secs === undefined ? "" : delay(f.secs),
    price: f.price === null || f.price === undefined ? "" : priceText(f.price),
    pct,
    usd,
    n: f.n ?? 0,
    x: f.x === null || f.x === undefined ? "" : times(f.x),
    text: f.text ?? "",
    status: f.status === null || f.status === undefined ? "" : t(`sources.status.${f.status}`),
    side:
      f.side === null || f.side === undefined
        ? ""
        : f.key === "action"
          ? f.side
          : t(`sides.${f.side}`),
    outcome: f.outcome ?? "",
    level: f.level === null || f.level === undefined ? "" : t(`levels.${f.level}`),
    sources: f.n === null || f.n === undefined ? "" : t("trades.sourcesN", { n: f.n }),
    source: f.source === null || f.source === undefined ? "" : t(`sources.names.${f.source}`),
    newsType:
      f.newsType === null || f.newsType === undefined ? "" : t(`trades.newsTypes.${f.newsType}`),
    hours: f.hours ?? 0,
    hold: f.hours === null || f.hours === undefined ? "" : hold(f.hours),
  };
  return <>{t(`detail.facts.${f.key}.value`, values)}</>;
}

const DOT = {
  pos: "bg-pos-bg text-pos",
  neg: "bg-neg-bg text-neg-ink",
  accent: "bg-accent-tint text-accent-ink",
  neutral: "bg-bg text-ink-2",
} as const;

function stepTone(s: ResearchStep, d: Detail): keyof typeof DOT {
  if (s.key === "checks") return s.checks.some((c) => !c.ok) ? "neg" : "pos";
  if (s.key === "trade") return "accent";
  if (s.key === "result") {
    const p = d.trade.result?.pnl ?? null;
    if (p === null || Number(p) === 0) return "neutral";
    return Number(p) > 0 ? "pos" : "neg";
  }
  return "pos";
}

function Step({
  s,
  i,
  last,
  d,
  tz,
}: {
  s: ResearchStep;
  i: number;
  last: boolean;
  d: Detail;
  tz: string;
}) {
  const t = useTranslations("signalAnalysis.research");
  const title =
    s.key === "scored" && s.score !== null
      ? t("detail.steps.scoredScore", { score: s.score.toFixed(2) })
      : s.key === "scored" && s.level !== null
        ? t("detail.steps.scoredLevel", { level: t(`levels.${s.level}`) })
        : t(`detail.steps.${s.key}`);
  return (
    <li className="flex gap-3.5">
      <span
        aria-hidden="true"
        className={`flex size-7 flex-none items-center justify-center rounded-full text-[13px] font-extrabold ${DOT[stepTone(s, d)]}`}
      >
        {i + 1}
      </span>
      <div
        className={`flex min-w-0 flex-1 flex-col gap-2 pb-[18px] ${last ? "" : "border-b border-bg"}`}
      >
        <h3 className="m-0 text-base font-extrabold">{title}</h3>
        {s.facts.length === 0 ? null : (
          <dl className="m-0 grid grid-cols-2 gap-x-3.5 gap-y-2">
            {s.facts.map((f, k) => (
              <div key={`${f.key}-${String(k)}`} className="min-w-0">
                <dt className="text-xs font-bold text-muted">{t(`detail.facts.${f.key}.label`)}</dt>
                <dd className="m-0 text-sm font-bold">
                  <FactValue f={f} tz={tz} />
                </dd>
              </div>
            ))}
          </dl>
        )}
        {s.parts.length === 0 ? null : (
          <dl className="m-0 flex flex-col gap-1 text-sm">
            {s.parts.map((p) => (
              <div key={p.key} className="flex justify-between gap-3">
                <dt>{t(`detail.partLabel.${p.key}`, { w: p.weight })}</dt>
                <dd className="m-0 font-bold">{signed(p.value, 2)}</dd>
              </div>
            ))}
          </dl>
        )}
        {s.checks.length === 0 ? null : (
          <ul className="m-0 flex list-disc flex-col gap-1 pl-[18px] text-sm text-ink-2">
            {s.checks.map((c) => (
              <li key={c.key} className={c.ok ? "" : "font-bold text-neg-ink"}>
                <span className="sr-only">
                  {c.ok ? t("detail.checkOk") : t("detail.checkFail")}:{" "}
                </span>
                {t(`detail.checks.${c.key}.${c.ok ? "ok" : "fail"}`, {
                  type: t(`types.${d.trade.type}`),
                  asset: d.trade.asset,
                  pct: given(c.pct) ? pctPlain(c.pct, Math.abs(c.pct) >= 1 ? 1 : 2) : t("na"),
                  cost: c.cost === null || c.cost === undefined ? t("na") : pctPlain(c.cost),
                  n: c.n ?? 0,
                })}
              </li>
            ))}
          </ul>
        )}
        {s.notes.map((n) => (
          <p key={n.key} className="m-0 text-[13px] text-ink-2">
            {n.key === "leaderboard"
              ? t("detail.notes.leaderboard", { date: monthDay(n.since, tz) })
              : t("detail.notes.weights", { v: n.version })}
          </p>
        ))}
      </div>
    </li>
  );
}

function ResultLine({ d }: { d: Detail }) {
  const t = useTranslations("signalAnalysis.research");
  const x = d.trade;
  const skip = skipText(x, t, false);
  if (skip !== null) return <p className="m-0 text-sm font-bold text-warn">{skip}</p>;
  const r = x.result;
  if (r === null) return null;
  const held = d.heldSecs;
  const outcome =
    r.outcome === "open"
      ? t("detail.outcome.open")
      : held === null
        ? t(`detail.outcome.${r.outcome}NoHeld`)
        : t(`detail.outcome.${r.outcome}`, { held: span(held) });
  const b = (c: ReactNode) => <b className={tone(r.pnl === null ? null : Number(r.pnl))}>{c}</b>;
  const pnl = r.pnl === null ? t("na") : usdSigned(r.pnl);
  return (
    <p className="m-0 text-sm text-ink-2">
      {d.sizeUsdc === null
        ? t.rich("detail.resultNoSize", { pnl, outcome, b })
        : t.rich("detail.result", { pnl, outcome, size: usdCompact(d.sizeUsdc), b })}
    </p>
  );
}

export function ResearchTradeDetail({
  id,
  ctx,
  onClose,
}: {
  id: string | null;
  ctx: PageCtx;
  onClose: () => void;
}) {
  const t = useTranslations("signalAnalysis.research");
  const q = useResearchTrade(id);
  const d = q.data;
  return (
    <BottomSheet
      open={id !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={d === undefined ? t("detail.loading") : tradeTitle(d.trade, t)}
      closeLabel={t("detail.close")}
      fullScreen
    >
      {q.isPending ? (
        <Skeleton className="h-64" />
      ) : q.isError || d === undefined ? (
        <p role="alert" className="m-0 text-sm text-ink-2">
          {t("detail.error")}
        </p>
      ) : (
        <div className="flex flex-col gap-[18px]">
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-1.5">
              <Pill tone={d.trade.label === "live" ? "paper" : "neutral"}>
                {t("detail.tagType", {
                  type: t(`types.${d.trade.type}`),
                  label: t(`labels.${d.trade.label}`),
                  v: d.rulesVersion,
                })}
              </Pill>
              <Pill tone={SIDE_TONE[d.trade.side]}>
                {t("detail.tagSide", { side: t(`sides.${d.trade.side}`), asset: d.trade.asset })}
              </Pill>
              {d.trade.retry ? <RetryTag /> : null}
            </div>
            <ResultLine d={d} />
          </div>
          {d.steps.length === 0 ? (
            <Na />
          ) : (
            <ol
              aria-label={t("detail.stepsLabel")}
              className="m-0 flex list-none flex-col gap-[18px] p-0"
            >
              {d.steps.map((s, i) => (
                <Step key={s.key} s={s} i={i} last={i === d.steps.length - 1} d={d} tz={ctx.tz} />
              ))}
            </ol>
          )}
        </div>
      )}
    </BottomSheet>
  );
}
