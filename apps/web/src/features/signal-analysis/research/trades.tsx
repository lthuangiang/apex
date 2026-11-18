"use client";

import { RESEARCH_LABELS, RESEARCH_TYPES, type ResearchTrade } from "@drift/shared";
import { RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";

import { FilterSelect, ScrollTable, Seg } from "../components/bits";
import type { PageCtx } from "../components/signal-analysis-page";
import { clock, monthDay } from "../format";

import { RESEARCH_DEFAULT, useResearchTrades, type ResearchFilters } from "./api";
import { ResearchTradeDetail } from "./detail";
import { delay, hold, pctSigned, priceText, tone, usdSigned } from "./format";
import { skipText, sourcesText, tradeTitle, type Tr } from "./text";
import { Block, Dash, Na, Pill, RetryTag, SIDE_TONE, Sub, tdR, tdW, thR, thW } from "./ui";

// Danh sách lệnh của Signal research: lệnh live paper (News) và lệnh replay (Whales / Funding / Price patterns) chung
// một dạng; tín hiệu bị bỏ qua kèm lý do. Mở trên "Entered"; phân trang bằng cursor ("Load more").

/** Dòng phụ dưới "What happened" (bảng desktop). */
function WhatSub({ x, tz }: { x: ResearchTrade; tz: string }) {
  const t = useTranslations("signalAnalysis.research");
  const skip = skipText(x, t, false);
  if (skip !== null) return <Sub className="font-bold text-warn">{skip}</Sub>;
  const w = x.what;
  const parts: ReactNode[] = [];
  if (w.type === "news") {
    parts.push(
      t("trades.newsLine", {
        type: t(`trades.newsTypes.${w.newsType}`),
        side: t(`sides.${x.side}`),
      }),
    );
    const src = sourcesText(w.sources, w.topTier, t);
    if (w.levelAtEntry !== null && src !== null)
      parts.push(
        t.rich("trades.enteredAt", {
          level: t(`levels.${w.levelAtEntry}`),
          sources: src,
          b: (c) => <b>{c}</b>,
        }),
      );
    if (w.later !== null)
      parts.push(
        t("trades.later", {
          level: t(`levels.${w.later.level}`),
          sources: t("trades.sourcesN", { n: w.later.sources }),
        }),
      );
    if (x.result?.outcome === "open") parts.push(t("trades.stillOpen"));
  } else if (w.type === "whales") {
    if (w.inLeaderboardSince !== null && w.sizeVsUsual !== null)
      parts.push(
        t("trades.whaleLine", {
          date: monthDay(w.inLeaderboardSince, tz),
          x: (Math.round(w.sizeVsUsual * 10) / 10).toString(),
        }),
      );
    parts.push(t("trades.entered"));
  } else {
    parts.push(t("trades.entered"));
  }
  return (
    <Sub>
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 ? t("trades.sep") : null}
          {p}
        </span>
      ))}
      {x.retry ? <RetryTag /> : null}
    </Sub>
  );
}

function seenSub(x: ResearchTrade, t: Tr, short: boolean): ReactNode {
  const k = short ? "trades.seenShort" : "trades.seen";
  if (x.delayKind === "atCandleClose" || x.delayKind === "atFundingTime")
    return t(`${k}.${x.delayKind}`);
  if (x.delaySecs === null) return <Na />;
  // News: độ trễ tính từ bài đầu của câu chuyện (#278); lần thử lại thì nói rõ là từ bài đầu.
  const kind = x.retry && x.delayKind === "afterRelease" ? "afterFirst" : x.delayKind;
  return t(`${k}.${kind}`, { d: delay(x.delaySecs) });
}

function resultSub(x: ResearchTrade, t: Tr): string | null {
  const r = x.result;
  if (r === null) return null;
  if (r.outcome === "open")
    return r.leftSecs === null
      ? t("trades.result.openNoLeft")
      : t("trades.result.open", { left: hold(r.leftSecs / 3600) });
  return t(`trades.result.${r.outcome}`);
}

function PriceCell({ v, pct }: { v: string | null; pct: number | null }) {
  if (v === null) return <Na />;
  return (
    <>
      {priceText(v)}
      {pct === null ? null : <Sub>{pctSigned(pct, 1)}</Sub>}
    </>
  );
}

function TypeLabel({ x }: { x: ResearchTrade }) {
  const t = useTranslations("signalAnalysis.research");
  return (
    <>
      {t(`types.${x.type}`)}
      {t("trades.sep")}
      {x.label === "live" ? <b className="text-unknown">{t("labels.live")}</b> : t("labels.replay")}
    </>
  );
}

const linkBtn =
  "cursor-pointer border-0 bg-transparent p-0 text-left text-sm font-bold text-accent-ink underline hover:text-accent";

export function ResearchTrades({ ctx, assets }: { ctx: PageCtx; assets: readonly string[] }) {
  const t = useTranslations("signalAnalysis.research");
  const ts = useTranslations("signalAnalysis.states");
  const [f, setF] = useState<ResearchFilters>(RESEARCH_DEFAULT);
  const [open, setOpen] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const q = useResearchTrades(f, true);
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const set = (p: Partial<ResearchFilters>) => {
    setF((x) => ({ ...x, ...p }));
  };
  const assetOpts = f.asset === null || assets.includes(f.asset) ? assets : [...assets, f.asset];
  return (
    <Block
      id="sr-trades"
      title={t("trades.title")}
      right={
        <button
          type="button"
          aria-expanded={showFilters}
          aria-controls="sr-trade-filters"
          onClick={() => {
            setShowFilters((x) => !x);
          }}
          className={`${linkBtn} inline-flex min-h-11 items-center md:hidden`}
        >
          {t("trades.filters")}
        </button>
      }
    >
      <div
        id="sr-trade-filters"
        role="group"
        aria-label={t("trades.filtersLabel")}
        className={`flex-wrap items-end gap-3 ${showFilters ? "flex" : "flex max-md:hidden"}`}
      >
        <FilterSelect
          label={t("trades.type")}
          value={f.type ?? ""}
          options={[
            { value: "", label: t("trades.allTypes") },
            ...RESEARCH_TYPES.map((k) => ({ value: k, label: t(`types.${k}`) })),
          ]}
          onChange={(v) => {
            set({ type: v === "" ? null : v });
          }}
        />
        <FilterSelect
          label={t("trades.tested")}
          value={f.label ?? ""}
          options={[
            { value: "", label: t("trades.allLabels") },
            ...RESEARCH_LABELS.map((k) => ({ value: k, label: t(`labels.${k}`) })),
          ]}
          onChange={(v) => {
            set({ label: v === "" ? null : v });
          }}
        />
        <FilterSelect
          label={t("trades.asset")}
          value={f.asset ?? ""}
          options={[
            { value: "", label: t("trades.allAssets") },
            ...assetOpts.map((a) => ({ value: a, label: a })),
          ]}
          onChange={(v) => {
            set({ asset: v === "" ? null : v });
          }}
        />
        <div className="flex flex-col gap-1">
          <span id="sr-show" className="text-[12.5px] font-bold text-ink-2">
            {t("trades.show")}
          </span>
          <Seg
            labelId="sr-show"
            value={f.show}
            options={(["entered", "skipped", "all"] as const).map((k) => ({
              value: k,
              label: t(`trades.shows.${k}`),
            }))}
            onChange={(show) => {
              set({ show });
            }}
          />
        </div>
      </div>
      {q.isPending ? (
        <div aria-busy="true" className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <span key={i} aria-hidden="true" className="h-14 rounded-tile bg-surface-2" />
          ))}
          <p role="status" className="m-0 text-[12.5px] text-muted">
            {t("states.tradesLoading")}
          </p>
        </div>
      ) : q.isError && items.length === 0 ? (
        <div role="alert" className="flex flex-col items-start gap-2 py-4">
          <span className="text-sm text-ink-2">{t("states.tradesError")}</span>
          <button
            type="button"
            onClick={() => void q.refetch()}
            className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-control border-0 bg-accent px-[18px] text-sm font-bold text-white"
          >
            <RefreshCw aria-hidden="true" size={16} />
            {ts("retry")}
          </button>
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
          <strong className="text-base">{t("states.tradesEmpty")}</strong>
          <span className="text-sm text-muted">{t("states.tradesEmptyBody")}</span>
          <button
            type="button"
            onClick={() => {
              setF(RESEARCH_DEFAULT);
            }}
            className="min-h-11 cursor-pointer rounded-control border border-border-input bg-surface px-4 text-sm font-bold text-ink"
          >
            {ts("clear")}
          </button>
        </div>
      ) : (
        <div aria-busy={q.isPlaceholderData} className={q.isPlaceholderData ? "opacity-50" : ""}>
          <div className="max-md:hidden">
            <TradesTable items={items} tz={ctx.tz} onOpen={setOpen} />
          </div>
          <TradeCards items={items} onOpen={setOpen} />
        </div>
      )}
      {q.hasNextPage ? (
        <button
          type="button"
          disabled={q.isFetchingNextPage}
          onClick={() => void q.fetchNextPage()}
          className={`${linkBtn} inline-flex min-h-11 items-center self-start`}
        >
          {t("trades.loadMore")}
        </button>
      ) : null}
      <ResearchTradeDetail
        id={open}
        ctx={ctx}
        onClose={() => {
          setOpen(null);
        }}
      />
    </Block>
  );
}

function TradesTable({
  items,
  tz,
  onOpen,
}: {
  items: ResearchTrade[];
  tz: string;
  onOpen: (id: string) => void;
}) {
  const t = useTranslations("signalAnalysis.research");
  const cols = [
    "colSignal",
    "colSeen",
    "colWhat",
    "colMoved",
    "colEntry",
    "colTp",
    "colSl",
    "colHold",
    "colResult",
  ] as const;
  return (
    <ScrollTable label={t("trades.table")}>
      <table className="w-full border-collapse">
        <caption className="sr-only">{t("trades.table")}</caption>
        <thead>
          <tr>
            {cols.map((k) => (
              <th key={k} scope="col" className={k === "colMoved" ? `${thW} min-w-24` : thR}>
                {t(`trades.${k}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((x) => {
            const skipped = x.skipped !== null;
            const title = tradeTitle(x, t);
            const pnl = x.result?.pnl ?? null;
            return (
              <tr key={x.id}>
                <td className={tdR}>
                  <span className="flex items-center gap-1.5">
                    <span className="font-bold">{x.asset}</span>
                    <Pill tone={SIDE_TONE[x.side]}>{t(`sides.${x.side}`)}</Pill>
                  </span>
                  <Sub>
                    <TypeLabel x={x} />
                  </Sub>
                </td>
                <td className={tdR}>
                  {clock(x.seenAt, tz)}
                  <Sub>{seenSub(x, t, false)}</Sub>
                </td>
                <td className={`${tdW} min-w-[180px]`}>
                  {/* Cả tín hiệu bị bỏ qua cũng mở được (#278: id là id sự kiện; các bước dừng ở kiểm tra không qua). */}
                  <button
                    type="button"
                    aria-haspopup="dialog"
                    onClick={() => {
                      onOpen(x.id);
                    }}
                    className={`${linkBtn} min-h-6`}
                  >
                    {title}
                  </button>
                  <WhatSub x={x} tz={tz} />
                </td>
                <td className={tdR}>
                  {skipped ? (
                    <Dash />
                  ) : x.movedBeforePct === null ? (
                    <Na />
                  ) : (
                    pctSigned(x.movedBeforePct, 1)
                  )}
                </td>
                <td className={tdR}>
                  {skipped ? (
                    <Dash />
                  ) : x.entry === null ? (
                    <Na />
                  ) : (
                    <>
                      {priceText(x.entry)}
                      {x.what.type === "whales" && x.delaySecs !== null ? (
                        <Sub>{t("trades.entryAfterFill", { d: delay(x.delaySecs) })}</Sub>
                      ) : null}
                    </>
                  )}
                </td>
                <td className={tdR}>{skipped ? <Dash /> : <PriceCell v={x.tp} pct={x.tpPct} />}</td>
                <td className={tdR}>{skipped ? <Dash /> : <PriceCell v={x.sl} pct={x.slPct} />}</td>
                <td className={tdR}>
                  {skipped ? <Dash /> : x.maxHoldHours === null ? <Na /> : hold(x.maxHoldHours)}
                </td>
                <td className={tdR}>
                  {skipped ? (
                    <span className="text-muted">{t("trades.notTraded")}</span>
                  ) : (
                    <>
                      {pnl === null ? (
                        <Na />
                      ) : (
                        <span className={`font-extrabold ${tone(Number(pnl))}`}>
                          {usdSigned(pnl)}
                        </span>
                      )}
                      <Sub>{resultSub(x, t)}</Sub>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </ScrollTable>
  );
}

function TradeCards({ items, onOpen }: { items: ResearchTrade[]; onOpen: (id: string) => void }) {
  const t = useTranslations("signalAnalysis.research");
  const na = t("na");
  const p = (v: string | null) => (v === null ? na : priceText(v));
  return (
    <ul className="m-0 flex list-none flex-col gap-2.5 p-0 md:hidden">
      {items.map((x) => {
        const skip = skipText(x, t, true);
        const pnl = x.result?.pnl ?? null;
        const out = x.result === null ? null : t(`trades.resultShort.${x.result.outcome}`);
        const body = (
          <>
            <span className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5">
                <b>{x.asset}</b>
                <Pill tone={SIDE_TONE[x.side]}>{t(`sides.${x.side}`)}</Pill>
              </span>
              {skip !== null ? (
                <span className="text-xs text-muted">{t("trades.notTraded")}</span>
              ) : pnl === null ? (
                <Na />
              ) : (
                <b className={tone(Number(pnl))}>{usdSigned(pnl)}</b>
              )}
            </span>
            <span className="text-sm">{tradeTitle(x, t)}</span>
            {skip !== null ? (
              <span className="text-xs font-bold text-warn">{skip}</span>
            ) : (
              <>
                <span className="text-xs text-muted">
                  <TypeLabel x={x} />
                  {t("trades.sep")}
                  {seenSub(x, t, true)}
                  {out === null ? null : (
                    <>
                      {t("trades.sep")}
                      {out}
                    </>
                  )}
                  {x.retry ? <RetryTag /> : null}
                </span>
                <span className="text-xs text-muted">
                  {t("trades.cardLevels", {
                    entry: p(x.entry),
                    tp: p(x.tp),
                    sl: p(x.sl),
                    hold: x.maxHoldHours === null ? na : hold(x.maxHoldHours),
                  })}
                </span>
              </>
            )}
          </>
        );
        const cls = "flex w-full flex-col gap-1.5 rounded-tile border border-border p-3 text-left";
        return (
          <li key={x.id}>
            <button
              type="button"
              aria-haspopup="dialog"
              onClick={() => {
                onOpen(x.id);
              }}
              className={`${cls} cursor-pointer bg-surface text-ink`}
            >
              {body}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
