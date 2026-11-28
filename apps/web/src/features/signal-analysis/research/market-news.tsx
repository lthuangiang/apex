"use client";

import type { ResearchArticle } from "@drift/shared";
import { Button } from "@drift/ui";
import { useTranslations } from "next-intl";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { clock, monthDay } from "../format";

import { useMarketArticles, type VersionId } from "./api";
import { Block, Pill, type PillTone } from "./ui";

// Khối "News by market" (#593, DEC-402 mục 6; bản phác docs/mockups/us-market màn 04): tab market, mỗi bài một dòng với
// market nó gắn, cách đọc (Positive / Negative / "Product, not company value"), kết quả của Rules và độ sâu sổ lệnh lúc
// quyết định ("Book at the time", chỉ market có chụp). Không bịa số (quy tắc 8): thiếu thì "–".

/** Tab theo bản phác; ANT-USD là market mới của DEC-402. */
export const MARKET_NEWS_TABS = [null, "BTC-USD", "ETH-USD", "ANT-USD"] as const;
type Tab = (typeof MARKET_NEWS_TABS)[number];
const NEW_MARKET = "ANT-USD";
const DASH = "–";

const tabKey = (m: Tab) => m ?? "all";

/** "$2,610.00" (hiển thị; số gốc là chuỗi thập phân của API). */
function usd(v: string): string {
  return Number(v).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

type Kind = "company" | "product" | null;

/** Tin công ty / sản phẩm chỉ có nghĩa với market công ty (ANT-USD): sản phẩm = lý do `productNews`, công ty = đã qua Score. */
function kindOf(a: ResearchArticle): Kind {
  if (a.reason === "productNews") return "product";
  if (a.asset === NEW_MARKET && a.side !== null) return "company";
  return null;
}

function marketOf(a: ResearchArticle, tab: Tab): string | null {
  if (tab !== null) return tab;
  return a.asset ?? a.candidates[0] ?? null;
}

export function MarketNews({
  tz,
  versionId,
  onSetUp,
}: {
  tz: string;
  versionId: VersionId;
  /** Mở "Set up News Signal" với ANT-USD chọn sẵn. */
  onSetUp: () => void;
}) {
  const t = useTranslations("signalAnalysis.research.marketNews");
  const [tab, setTab] = useState<Tab>(null);
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const q = useMarketArticles(tab, versionId);

  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = MARKET_NEWS_TABS.indexOf(tab);
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    const end = e.key === "End";
    const home = e.key === "Home";
    if (d === 0 && !end && !home) return;
    e.preventDefault();
    const n = MARKET_NEWS_TABS.length;
    const next = home
      ? null
      : end
        ? (MARKET_NEWS_TABS[n - 1] ?? null)
        : (MARKET_NEWS_TABS[(i + d + n) % n] ?? null);
    setTab(next);
    refs.current.get(tabKey(next))?.focus();
  };

  const readAs = (a: ResearchArticle): ReactNode => {
    if (a.reason === "productNews") return <Pill tone="neutral">{t("readAs.product")}</Pill>;
    if (a.side === "long") return <Pill tone="pos">{t("readAs.positive")}</Pill>;
    if (a.side === "short") return <Pill tone="neg">{t("readAs.negative")}</Pill>;
    return <span className="text-muted">{DASH}</span>;
  };
  const rules = (a: ResearchArticle): ReactNode => {
    const [tone, key]: [PillTone, string] =
      a.outcome === "traded"
        ? ["pos", "traded"]
        : a.outcome === "waiting"
          ? ["neutral", "waiting"]
          : ["neutral", "skipped"];
    return <Pill tone={tone}>{t(`rules.${key}`)}</Pill>;
  };
  const book = (a: ResearchArticle) =>
    a.book == null ? DASH : t("book", { bids: usd(a.book.bidsUsd), asks: usd(a.book.asksUsd) });
  const sub = (a: ResearchArticle) => {
    const k = kindOf(a);
    return k === null ? a.source : t(`kind.${k}`, { source: a.source });
  };
  const time = (a: ResearchArticle) =>
    `${monthDay(a.publishedAt, tz)}, ${clock(a.publishedAt, tz, false)}`;
  const title = (a: ResearchArticle) => a.title ?? t("noTitle");

  let body: ReactNode;
  if (q.isPending) body = <p className="m-0 text-sm text-muted">{t("loading")}</p>;
  else if (q.isError && q.data === undefined)
    body = (
      <p role="alert" className="m-0 text-sm text-neg-ink">
        {t("error")}
      </p>
    );
  else if (q.data.items.length === 0) body = <p className="m-0 text-sm text-muted">{t("empty")}</p>;
  else {
    const items = q.data.items;
    const th = "px-2 py-2.5 text-xs font-bold uppercase tracking-wide text-muted";
    const td = "border-t border-border px-2 py-3 align-middle";
    body = (
      <>
        <table className="w-full border-collapse text-sm max-md:hidden">
          <thead>
            <tr>
              <th scope="col" className={`${th} text-left`}>
                {t("cols.news")}
              </th>
              <th scope="col" className={`${th} text-right`}>
                {t("cols.time")}
              </th>
              <th scope="col" className={`${th} text-right`}>
                {t("cols.market")}
              </th>
              <th scope="col" className={`${th} text-right`}>
                {t("cols.readAs")}
              </th>
              <th scope="col" className={`${th} text-right`}>
                {t("cols.rules")}
              </th>
              <th scope="col" className={`${th} text-right`}>
                {t("cols.book")}
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((a) => (
              <tr key={a.id}>
                <td className={td}>
                  <span className="block font-bold text-ink">{title(a)}</span>
                  <span className="block text-xs text-muted">{sub(a)}</span>
                </td>
                <td className={`${td} whitespace-nowrap text-right tabular-nums text-ink`}>
                  {time(a)}
                </td>
                <td className={`${td} whitespace-nowrap text-right font-bold text-ink`}>
                  {marketOf(a, tab) ?? DASH}
                </td>
                <td className={`${td} text-right`}>{readAs(a)}</td>
                <td className={`${td} text-right`}>{rules(a)}</td>
                <td className={`${td} whitespace-nowrap text-right tabular-nums text-ink`}>
                  {book(a)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <ul aria-label={t("listLabel")} className="m-0 flex list-none flex-col p-0 md:hidden">
          {items.map((a) => (
            <li key={a.id} className="flex flex-col gap-1.5 border-t border-border py-3 text-sm">
              <span className="font-bold text-ink">{title(a)}</span>
              <span className="text-xs text-muted">
                {sub(a)} · {time(a)} · {marketOf(a, tab) ?? DASH}
              </span>
              <span className="flex flex-wrap items-center gap-2">
                {readAs(a)}
                {rules(a)}
              </span>
              <span className="text-xs text-ink-2">
                {t("cols.book")}: <span className="tabular-nums text-ink">{book(a)}</span>
              </span>
            </li>
          ))}
        </ul>
      </>
    );
  }

  return (
    <Block id="sr-market-news" title={t("title")}>
      <p className="m-0 -mt-2 text-sm text-ink-2">{t("desc")}</p>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span
          role="tablist"
          aria-label={t("tabsLabel")}
          className="flex gap-2 overflow-x-auto max-md:mask-r-from-85%"
        >
          {MARKET_NEWS_TABS.map((m) => {
            const on = m === tab;
            const k = tabKey(m);
            return (
              <button
                key={k}
                ref={(el) => {
                  if (el === null) refs.current.delete(k);
                  else refs.current.set(k, el);
                }}
                type="button"
                role="tab"
                id={`sr-market-tab-${k}`}
                aria-selected={on}
                aria-controls="sr-market-panel"
                tabIndex={on ? 0 : -1}
                onKeyDown={onKey}
                onClick={() => {
                  setTab(m);
                }}
                className={`inline-flex min-h-11 flex-none cursor-pointer items-center gap-2 whitespace-nowrap rounded-tile border px-4 text-sm font-extrabold md:min-h-10 ${
                  on ? "border-ink bg-ink text-surface" : "border-border bg-surface text-ink"
                }`}
              >
                {m ?? t("all")}
                {m === NEW_MARKET ? " " : null}
                {m === NEW_MARKET ? (
                  <span className="rounded-full bg-pos-bg px-2 py-0.5 text-[11px] font-extrabold text-pos">
                    {t("new")}
                  </span>
                ) : null}
              </button>
            );
          })}
        </span>
        {tab === NEW_MARKET ? <span className="text-sm text-ink-2">{t("antNote")}</span> : null}
      </div>
      <div
        id="sr-market-panel"
        role="tabpanel"
        aria-labelledby={`sr-market-tab-${tabKey(tab)}`}
        className="flex min-w-0 flex-col gap-3"
      >
        {body}
        {tab === NEW_MARKET ? (
          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <p className="m-0 text-sm text-ink-2">{t("footnote")}</p>
            <Button onClick={onSetUp} className="font-extrabold">
              {t("setUp")}
            </Button>
          </div>
        ) : null}
        <p className="m-0 text-xs text-muted">{t("notForecast")}</p>
      </div>
    </Block>
  );
}
