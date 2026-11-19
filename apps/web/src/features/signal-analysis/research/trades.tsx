"use client";

import { RESEARCH_LABELS, RESEARCH_TYPES, type ResearchTrade } from "@drift/shared";
import { RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";

import { useMarketNames } from "@/lib/markets";

import { FilterSelect, ScrollTable, Seg } from "../components/bits";
import type { PageCtx } from "../components/signal-analysis-page";
import { clock, monthDay } from "../format";

import { RESEARCH_DEFAULT, useResearchTrades, type ResearchFilters } from "./api";
import { ResearchTradeDetail } from "./detail";
import { delay, hold, pctSigned, priceText, tickPrice, tone, usdSigned } from "./format";
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

/**
 * #306: tín hiệu bị giới hạn / số dư chặn vẫn được theo dõi giả định (shadow, ngoài balance): "Would have: hit take
 * profit · +$4.20". Lý do ("Limit: 20 open") đã ở cột What happened.
 */
function ShadowSub({ x }: { x: ResearchTrade }) {
  const t = useTranslations("signalAnalysis.research");
  const s = x.skipped?.shadow ?? null;
  if (s === null) return null;
  const outcome = t(`trades.resultShort.${s.outcome}`);
  return (
    <Sub>
      {s.pnl === null
        ? t("trades.shadow", { outcome })
        : t("trades.shadowPnl", { outcome, pnl: usdSigned(s.pnl) })}
    </Sub>
  );
}

/** #306: nhãn "opposite news" khi có tin ngược chiều lúc lệnh đang mở (giữ hay đóng, kết quả giả định nếu đóng lúc đó). */
function OppositeTag({ x, tz }: { x: ResearchTrade; tz: string }) {
  const t = useTranslations("signalAnalysis.research");
  const o = x.opposite;
  if (o === null) return null;
  const tip = t("trades.oppositeTip", {
    time: clock(o.at, tz, false),
    action: o.action,
    usd: usdSigned(o.resultUsdc),
    pct: pctSigned(o.resultPct),
  });
  return (
    <span
      title={tip}
      className="mt-1 inline-block whitespace-nowrap rounded-full bg-warn-bg px-2 py-0.5 text-xs font-bold text-warn"
    >
      {t("trades.opposite")}
      <span className="sr-only">: {tip}</span>
    </span>
  );
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

function PriceCell({
  v,
  pct,
  tick,
  entry,
}: {
  v: string | null;
  pct: number | null;
  tick: string | null;
  entry: string | null;
}) {
  if (v === null) return <Na />;
  return (
    <>
      {tickPrice(v, tick, entry)}
      {pct === null ? null : <Sub>{pctSigned(pct, 1)}</Sub>}
    </>
  );
}

/**
 * Kết quả hiện ở cột Result / thẻ (#297): lệnh đã đóng → kết quả sau phí; lệnh đang mở → lãi / lỗ chưa chốt theo giá
 * SoDEX nếu API có, không thì null (bảng: "Not available"; thẻ: "Open").
 */
function shownPnl(x: ResearchTrade): { v: string; open: boolean } | null {
  const r = x.result;
  if (r === null) return null;
  if (r.outcome === "open") return r.unrealized === null ? null : { v: r.unrealized, open: true };
  return r.pnl === null ? null : { v: r.pnl, open: false };
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

export function ResearchTrades({
  ctx,
  assets,
  onTrace,
  versionId = null,
}: {
  ctx: PageCtx;
  assets: readonly string[];
  /** #306: News bot version của danh sách; null = Baseline. */
  versionId?: string | null;
  /** Nút Trace (#292): mở phễu ở trên trên bài của dòng này. */
  onTrace: (articleId: string) => void;
}) {
  const t = useTranslations("signalAnalysis.research");
  const ts = useTranslations("signalAnalysis.states");
  const [f, setF] = useState<ResearchFilters>(RESEARCH_DEFAULT);
  const [open, setOpen] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const q = useResearchTrades(f, true, versionId);
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const set = (p: Partial<ResearchFilters>) => {
    setF((x) => ({ ...x, ...p }));
  };
  const assetOpts = f.asset === null || assets.includes(f.asset) ? assets : [...assets, f.asset];
  return (
    <Block
      id="sr-trades"
      title={t("trades.title")}
      // Dưới 1024px: thanh nav cố định cao ~110 px (nút Agent nổi 26 px) mà main chỉ chừa 6rem; thêm lề để trạng thái
      // rỗng / "Load more" ở cuối trang không bị che.
      className="max-lg:mb-6"
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
            <TradesTable items={items} tz={ctx.tz} onOpen={setOpen} onTrace={onTrace} />
          </div>
          <TradeCards items={items} tz={ctx.tz} onOpen={setOpen} onTrace={onTrace} />
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

/** Độ rộng cột của bảng từ 1280 px (#297): Signal, Seen, What, Moved, Entry, TP, SL, Max hold, Result, Trace. */
const COL_WIDTHS = [
  "xl:w-[12%]",
  "xl:w-[10%]",
  "xl:w-[22%]",
  "xl:w-[7%]",
  "xl:w-[8%]",
  "xl:w-[9%]",
  "xl:w-[9%]",
  "xl:w-[6%]",
  "xl:w-[9%]",
  "xl:w-[8%]",
] as const;

const traceBtn =
  "min-h-10 cursor-pointer whitespace-nowrap rounded-control border border-border-input bg-surface px-3 text-[13px] font-extrabold text-accent-ink";

/** Nút Trace: chỉ dòng có bài (News); replay / dòng thiếu bài không có (`articleId = null`). */
function TraceButton({
  x,
  onTrace,
  className = "",
}: {
  x: ResearchTrade;
  onTrace: (articleId: string) => void;
  className?: string;
}) {
  const t = useTranslations("signalAnalysis.research");
  const id = x.articleId;
  if (id === null) return null;
  return (
    <button
      type="button"
      aria-label={t("trace.traceAria", { title: tradeTitle(x, t) })}
      onClick={() => {
        onTrace(id);
      }}
      className={`${traceBtn} ${className}`}
    >
      {t("trace.traceBtn")}
    </button>
  );
}

function TradesTable({
  items,
  tz,
  onOpen,
  onTrace,
}: {
  items: ResearchTrade[];
  tz: string;
  onOpen: (id: string) => void;
  onTrace: (articleId: string) => void;
}) {
  const t = useTranslations("signalAnalysis.research");
  const names = useMarketNames();
  const tickOf = (m: string) => names.info(m)?.tickSize ?? null;
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
    // #297: từ 1280 px bảng vừa khung (table-fixed, độ rộng cột theo %), không cuộn ngang; dưới 1280 px mới cuộn.
    <ScrollTable label={t("trades.table")}>
      <table className="w-full min-w-[1100px] border-collapse xl:min-w-0 xl:table-fixed">
        <caption className="sr-only">{t("trades.table")}</caption>
        <colgroup>
          {COL_WIDTHS.map((w, i) => (
            <col key={i} className={w} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {cols.map((k) => (
              <th key={k} scope="col" className={thW}>
                {t(`trades.${k}`)}
              </th>
            ))}
            <th scope="col" className={thR}>
              <span className="sr-only">{t("trace.traceCol")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((x) => {
            const skipped = x.skipped !== null;
            const title = tradeTitle(x, t);
            const pnl = shownPnl(x);
            const tick = tickOf(x.asset);
            return (
              <tr key={x.id}>
                <td className={tdW}>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="font-bold">{x.asset}</span>
                    <Pill tone={SIDE_TONE[x.side]}>{t(`sides.${x.side}`)}</Pill>
                  </span>
                  <Sub>
                    <TypeLabel x={x} />
                  </Sub>
                </td>
                <td className={tdW}>
                  {clock(x.seenAt, tz)}
                  <Sub>{seenSub(x, t, false)}</Sub>
                </td>
                <td className={tdW}>
                  {/* Cả tín hiệu bị bỏ qua cũng mở được (#278: id là id sự kiện; các bước dừng ở kiểm tra không qua). */}
                  <button
                    type="button"
                    aria-haspopup="dialog"
                    onClick={() => {
                      onOpen(x.id);
                    }}
                    title={title}
                    className={`${linkBtn} line-clamp-2 min-h-6 [overflow-wrap:anywhere]`}
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
                <td className={tdR}>
                  {skipped ? (
                    <Dash />
                  ) : (
                    <PriceCell v={x.tp} pct={x.tpPct} tick={tick} entry={x.entry} />
                  )}
                </td>
                <td className={tdR}>
                  {skipped ? (
                    <Dash />
                  ) : (
                    <PriceCell v={x.sl} pct={x.slPct} tick={tick} entry={x.entry} />
                  )}
                </td>
                <td className={tdR}>
                  {skipped ? <Dash /> : x.maxHoldHours === null ? <Na /> : hold(x.maxHoldHours)}
                </td>
                <td className={tdW}>
                  {skipped ? (
                    <>
                      <span className="text-muted">{t("trades.notTraded")}</span>
                      <ShadowSub x={x} />
                    </>
                  ) : (
                    <>
                      {pnl === null ? (
                        x.result?.outcome === "open" ? null : (
                          <Na />
                        )
                      ) : (
                        <span className={`font-extrabold ${tone(Number(pnl.v))}`}>
                          {pnl.open
                            ? t("trades.unrealized", { pnl: usdSigned(pnl.v) })
                            : usdSigned(pnl.v)}
                        </span>
                      )}
                      <Sub>{resultSub(x, t)}</Sub>
                      <OppositeTag x={x} tz={tz} />
                    </>
                  )}
                </td>
                <td className={`${tdR} text-right`}>
                  <TraceButton x={x} onTrace={onTrace} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </ScrollTable>
  );
}

function TradeCards({
  items,
  tz,
  onOpen,
  onTrace,
}: {
  items: ResearchTrade[];
  tz: string;
  onOpen: (id: string) => void;
  onTrace: (articleId: string) => void;
}) {
  const t = useTranslations("signalAnalysis.research");
  const names = useMarketNames();
  const na = t("na");
  const p = (v: string | null) => (v === null ? na : priceText(v));
  const tp = (v: string | null, x: ResearchTrade) =>
    v === null ? na : tickPrice(v, names.info(x.asset)?.tickSize ?? null, x.entry);
  return (
    <ul className="m-0 flex list-none flex-col gap-2.5 p-0 md:hidden">
      {items.map((x) => {
        const skip = skipText(x, t, true);
        const pnl = shownPnl(x);
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
              ) : pnl !== null ? (
                <b className={tone(Number(pnl.v))}>
                  {pnl.open ? t("trades.unrealized", { pnl: usdSigned(pnl.v) }) : usdSigned(pnl.v)}
                </b>
              ) : x.result?.outcome === "open" ? (
                // Lệnh đang mở chưa có giá SoDEX: ghi "Open", không bao giờ 0 (#297).
                <b>{t("trades.openCard")}</b>
              ) : (
                <Na />
              )}
            </span>
            <span className="text-sm">{tradeTitle(x, t)}</span>
            {skip !== null ? (
              <>
                <span className="text-xs font-bold text-warn">{skip}</span>
                <ShadowSub x={x} />
              </>
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
                    tp: tp(x.tp, x),
                    sl: tp(x.sl, x),
                    hold: x.maxHoldHours === null ? na : hold(x.maxHoldHours),
                  })}
                </span>
                <OppositeTag x={x} tz={tz} />
              </>
            )}
          </>
        );
        const cls = "flex w-full flex-col gap-1.5 rounded-tile border border-border p-3 text-left";
        return (
          <li key={x.id} className="flex flex-col gap-1.5">
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
            <TraceButton x={x} onTrace={onTrace} className="self-end" />
          </li>
        );
      })}
    </ul>
  );
}
