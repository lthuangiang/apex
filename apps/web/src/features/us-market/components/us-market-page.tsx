"use client";

import type {
  UsMarketRow,
  UsMarketsResponse,
  WealthFundRow,
  WealthMeResponse,
} from "@drift/shared";
import { DataTable, ErrorState, Skeleton } from "@drift/ui";
import Link from "next/link";
import { notFound } from "next/navigation";
import { useTranslations } from "next-intl";

import { PageHead, Workspace } from "@/components/workspace";
import { useFeatures } from "@/lib/queries";

import { MY_WEALTH_HREF, SODEX_WEALTH_URL } from "../links";
import { useUsMarkets, useWealthMe } from "../queries";
import { anthropicStrategyChips, marketLabel, secondsSince, shortMarketLabel, usd } from "../shape";

import { BookStatusPill, DepthPair, useAgo, useNow } from "./parts";

// Trang US Market (`/markets/us`, bản phác màn 02, DEC-402 mục 1–4, 8, 9). Sau công tắc `usMarket` của `/features`: tắt thì
// Not found như route chưa có. Mọi số lấy từ `GET /api/v1/markets/us` / `GET /api/v1/wealth/me`; thiếu thì "Not provided"
// hoặc "–" (quy tắc 8). Không logo bên thứ ba, không nút "Tell me when it trades", không Funding Arbitrage trên ANT.

/** Số token quỹ hiện thành dòng; phần còn lại gộp vào "N more: …" như bản phác. */
export const TOKEN_ROWS = 3;

const CARD = "flex min-w-0 flex-col gap-3 rounded-card border border-border bg-surface p-5";
const BTN =
  "inline-flex min-h-tap items-center justify-center whitespace-nowrap rounded-control border border-border-input bg-surface px-4 text-sm font-extrabold text-ink no-underline";
const BTN_PRI =
  "inline-flex min-h-tap items-center justify-center whitespace-nowrap rounded-control bg-accent px-4 text-sm font-extrabold text-white no-underline";
const NEW_CHIP =
  "rounded-full bg-pos-bg px-[7px] py-0.5 text-[10px] font-extrabold tracking-[0.04em] text-pos";

export function UsMarketPage() {
  const features = useFeatures();
  if (features.data !== undefined && !features.data.usMarket) notFound();
  return (
    <Workspace current="bots">
      {features.data?.usMarket === true ? (
        <UsMarketContent />
      ) : (
        <Skeleton className="h-40 rounded-card" />
      )}
    </Workspace>
  );
}

function UsMarketContent() {
  const t = useTranslations("usMarket");
  const te = useTranslations("common.errors");
  const markets = useUsMarkets();
  const wealth = useWealthMe();
  const now = useNow();
  return (
    <div className="flex flex-col gap-[18px]">
      <nav aria-label={t("page.crumbLabel")} className="text-[13px] font-semibold text-ink-2">
        <Link href="/bots?tab=catalog" className="text-ink-2 no-underline">
          {t("page.crumbLab")}
        </Link>
        <span aria-hidden="true"> › </span>
        <span aria-current="page">{t("page.title")}</span>
      </nav>
      <PageHead
        title={t("page.title")}
        subtitle={t("page.subtitle")}
        back={{ href: "/bots?tab=catalog", label: t("page.crumbLab") }}
      />
      {wealth.data?.status === "ok" ? <WealthStrip data={wealth.data} /> : null}
      {markets.isPending ? (
        <Skeleton className="h-64 rounded-card" />
      ) : markets.isError ? (
        <ErrorState
          title={t("page.loadError")}
          retryLabel={te("retry")}
          onRetry={() => {
            void markets.refetch();
          }}
        />
      ) : (
        <>
          <AnthropicCard data={markets.data} now={now} />
          <FundsCard data={markets.data} wealth={wealth.data} now={now} />
          <TokensCard data={markets.data} now={now} />
        </>
      )}
      <p className="m-0 text-xs text-ink-2">{t("page.disclaimer")}</p>
    </div>
  );
}

function WealthStrip({ data }: { data: Extract<WealthMeResponse, { status: "ok" }> }) {
  const t = useTranslations("usMarket.wealth");
  const tm = useTranslations("common.missing");
  const s = data.summary;
  const signedTone = (v: string | null) =>
    v === null ? "text-surface" : v.startsWith("-") ? "text-on-ink-neg" : "text-on-ink-pos";
  const label = "text-[11.5px] font-extrabold uppercase tracking-[0.04em] text-on-ink-2";
  return (
    <section
      aria-label={t("label")}
      className="flex flex-wrap items-center justify-between gap-6 rounded-card bg-ink px-6 py-5 text-surface"
    >
      <dl className="m-0 flex flex-wrap items-end gap-x-9 gap-y-3">
        <div>
          <dt className={label}>{t("label")}</dt>
          <dd className="m-0 mt-0.5 text-[28px] font-extrabold tabular-nums">
            {usd(s.totalValue) ?? tm("notProvided")}
          </dd>
        </div>
        <div>
          <dt className={label}>{t("totalResult")}</dt>
          <dd
            className={`m-0 mt-1.5 text-xl font-extrabold tabular-nums ${signedTone(s.totalPnl)}`}
          >
            {usd(s.totalPnl, true) ?? tm("notProvided")}
          </dd>
        </div>
        <div>
          <dt className={label}>{t("h24")}</dt>
          <dd
            className={`m-0 mt-1.5 text-xl font-extrabold tabular-nums ${signedTone(s.totalPnl24h)}`}
          >
            {usd(s.totalPnl24h, true) ?? tm("notProvided")}
          </dd>
        </div>
        <div>
          <dt className={label}>{t("fundsHeld")}</dt>
          <dd className="m-0 mt-1.5 text-xl font-extrabold tabular-nums">{data.holdings.length}</dd>
        </div>
      </dl>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[12.5px] text-on-ink-2">{t("source")}</span>
        <Link href={MY_WEALTH_HREF} className={BTN_PRI}>
          {t("open")}
        </Link>
      </div>
    </section>
  );
}

function AnthropicCard({ data, now }: { data: UsMarketsResponse; now: number }) {
  const t = useTranslations("usMarket.anthropic");
  const tm = useTranslations("common.missing");
  const tn = useTranslations("createBot.strategies");
  const ago = useAgo();
  const features = useFeatures().data;
  const rows = data.anthropic;
  const thin = rows.some((r) => r.depth !== null && r.depth.label !== "ok");
  // News Signal tạo từ Signal Research (không có `/bots/new/news_signal`): chỉ khi tài khoản thấy trang đó.
  const chips = anthropicStrategyChips().filter(
    (c) => c.strategy !== "news_signal" || features?.signalResearch === true,
  );
  const chipHref = (c: (typeof chips)[number]) =>
    c.strategy === "news_signal"
      ? "/signal-research"
      : `/bots/new/${c.strategy}?${new URLSearchParams({ market: c.symbol, engine: c.engine }).toString()}`;
  return (
    <section aria-labelledby="us-anthropic" className={CARD}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 id="us-anthropic" className="m-0 text-[17px] font-extrabold">
              {t("title")}
            </h2>
            <span className={NEW_CHIP}>{t("new")}</span>
          </div>
          <p className="m-0 mt-0.5 text-xs font-semibold text-ink-2">{t("subtitle")}</p>
        </div>
        <span className="text-[12.5px] text-ink-2">
          {t("readAgo", { n: secondsSince(data.readAt, now) })}
        </span>
      </div>
      <DataTable<UsMarketRow>
        caption={t("caption")}
        label={t("caption")}
        status={rows.length === 0 ? "empty" : "ready"}
        empty={{ title: tm("notAvailable") }}
        error={{ title: tm("notAvailable") }}
        rows={rows}
        getRowKey={(r) => r.symbol}
        columns={[
          {
            key: "market",
            header: t("cols.market"),
            cell: (r) => (
              <div>
                <div className="text-[14.5px] font-extrabold">{marketLabel(r.symbol)}</div>
                <div className="text-xs font-semibold text-ink-2">
                  {r.engine === "perps"
                    ? r.maxLeverage === null
                      ? t("perps")
                      : t("perpsMax", { lev: r.maxLeverage })
                    : t("spot")}
                </div>
              </div>
            ),
          },
          {
            key: "price",
            header: t("cols.lastPrice"),
            numeric: true,
            cell: (r) => usd(r.lastPrice) ?? tm("notProvided"),
          },
          {
            key: "volume",
            header: t("cols.volume"),
            numeric: true,
            // Ticker là của phiên gần nhất: lần khớp cuối cũ hơn 24 giờ thì api trả volume null → "Last trade …".
            cell: (r) =>
              r.volume24h !== null
                ? usd(r.volume24h)
                : r.lastTradeAt !== null
                  ? t("lastTrade", { ago: ago(r.lastTradeAt, now) })
                  : tm("notProvided"),
          },
          {
            key: "book",
            header: t("cols.book"),
            cell: (r) => <BookStatusPill status={r.bookStatus} />,
          },
          {
            key: "depth",
            header: t("cols.depth"),
            numeric: true,
            cell: (r) => <DepthPair depth={r.depth} />,
          },
          {
            key: "largest",
            header: t("cols.largest"),
            numeric: true,
            cell: (r) => {
              const v = usd(r.depth?.maxPositionUsd ?? null);
              return v === null ? "–" : <b>{v}</b>;
            },
          },
          {
            key: "action",
            header: t("cols.actions"),
            cell: (r) => (
              <Link
                href={`/bots?${new URLSearchParams({ tab: "catalog", market: r.symbol, engine: r.engine }).toString()}`}
                aria-label={t("startBotOn", { market: marketLabel(r.symbol) })}
                className={BTN_PRI}
              >
                {t("startBot")}
              </Link>
            ),
          },
        ]}
      />
      {thin ? (
        <p className="m-0 rounded-tile border border-dashed border-border-input px-3.5 py-3 text-[12.5px] leading-normal text-ink-2">
          <b className="text-ink">{t("thinTitle")}</b> {t("thinBody")}
        </p>
      ) : null}
      <h3 className="m-0 mt-1 text-[12.5px] font-extrabold text-ink">{t("strategiesTitle")}</h3>
      <ul className="m-0 flex list-none flex-wrap gap-3 p-0">
        {chips.map((c) => (
          <li key={`${c.strategy}:${c.symbol}`}>
            <Link href={chipHref(c)} className={BTN}>
              {t("chip", {
                // Bot news tên "News Signal" ở bản phác màn 02 (tên chiến lược trong form là của trang Signal Research).
                strategy: c.strategy === "news_signal" ? t("newsSignal") : tn(`${c.strategy}.name`),
                market: shortMarketLabel(c.symbol),
              })}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function FundsCard({
  data,
  wealth,
  now,
}: {
  data: UsMarketsResponse;
  wealth: WealthMeResponse | undefined;
  now: number;
}) {
  const t = useTranslations("usMarket.funds");
  const tm = useTranslations("common.missing");
  const held = new Map(
    (wealth?.status === "ok" ? wealth.holdings : []).map((h) => [h.fundId, h.marketValue]),
  );
  const opensOn = (iso: string) =>
    new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(new Date(iso));
  const requests = (f: WealthFundRow) => {
    if (f.requests === null) return <span className="text-xs text-ink-2">{tm("notProvided")}</span>;
    if (f.requests.open)
      return (
        <span className="rounded-full bg-pos-bg px-[11px] py-1 text-xs font-extrabold text-pos">
          {t("open")}
        </span>
      );
    const next = f.requests.nextChannelAt;
    return (
      <span className="whitespace-nowrap rounded-full bg-surface-2 px-[11px] py-1 text-xs font-extrabold text-ink-2">
        {next !== null && Date.parse(next) > now
          ? t("opensOn", { day: opensOn(next) })
          : t("closed")}
      </span>
    );
  };
  const items = data.funds.status === "ok" ? data.funds.items : [];
  const wealthUrl = SODEX_WEALTH_URL;
  return (
    <section aria-labelledby="us-funds" className={CARD}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-[1_1_320px]">
          <h2 id="us-funds" className="m-0 text-[17px] font-extrabold">
            {t("title")}
          </h2>
          <p className="m-0 mt-0.5 text-xs font-semibold text-ink-2">{t("subtitle")}</p>
        </div>
        {wealthUrl === null ? null : (
          <a href={wealthUrl} target="_blank" rel="noopener noreferrer" className={BTN}>
            {t("openSodex")}
          </a>
        )}
      </div>
      {data.funds.status === "not_provided" ? (
        <p className="m-0 text-sm text-ink-2">{tm("notAvailable")}</p>
      ) : (
        <DataTable<WealthFundRow>
          caption={t("title")}
          label={t("title")}
          status={items.length === 0 ? "empty" : "ready"}
          empty={{ title: t("empty") }}
          error={{ title: tm("notAvailable") }}
          rows={items}
          getRowKey={(f) => f.fundId}
          columns={[
            {
              key: "fund",
              header: t("cols.fund"),
              cell: (f) => <span className="text-[14.5px] font-extrabold">{f.name}</span>,
            },
            {
              key: "type",
              header: t("cols.type"),
              cell: (f) => <span className="text-xs font-semibold text-ink-2">{f.fundType}</span>,
            },
            {
              key: "nav",
              header: t("cols.nav"),
              numeric: true,
              cell: (f) => usd(f.nav) ?? tm("notProvided"),
            },
            {
              key: "size",
              header: t("cols.size"),
              numeric: true,
              cell: (f) =>
                usd(f.aum) ?? <span className="text-xs text-ink-2">{tm("notProvided")}</span>,
            },
            { key: "requests", header: t("cols.requests"), cell: requests },
            {
              key: "held",
              header: t("cols.held"),
              numeric: true,
              cell: (f) => {
                const v = usd(held.get(f.fundId) ?? null);
                return v === null ? "–" : <b>{v}</b>;
              },
            },
            ...(wealthUrl === null
              ? []
              : [
                  {
                    key: "invest",
                    header: t("cols.actions"),
                    cell: (f: WealthFundRow) => (
                      <a
                        href={wealthUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={t("investOn", { fund: f.name })}
                        className={BTN}
                      >
                        {t("invest")}
                      </a>
                    ),
                  },
                ]),
          ]}
        />
      )}
      <p className="m-0 text-[12.5px] text-ink-2">{t("note")}</p>
    </section>
  );
}

function TokensCard({ data, now }: { data: UsMarketsResponse; now: number }) {
  const t = useTranslations("usMarket.tokens");
  const ta = useTranslations("usMarket.anthropic");
  const tm = useTranslations("common.missing");
  const ago = useAgo();
  const items = data.fundTokens.status === "ok" ? data.fundTokens.items : [];
  const shown = items.slice(0, TOKEN_ROWS);
  const more = items.slice(TOKEN_ROWS);
  return (
    <section aria-labelledby="us-tokens" className={CARD}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-[1_1_320px]">
          <h2 id="us-tokens" className="m-0 text-[17px] font-extrabold">
            {t("title")}
          </h2>
          <p className="m-0 mt-0.5 text-xs font-semibold text-ink-2">{t("subtitle")}</p>
        </div>
        <span className="rounded-full bg-surface-2 px-[11px] py-1 text-xs font-extrabold text-ink-2">
          {t("watching")}
        </span>
      </div>
      {data.fundTokens.status === "not_provided" ? (
        <p className="m-0 text-sm text-ink-2">{tm("notAvailable")}</p>
      ) : (
        <DataTable<UsMarketRow>
          caption={t("title")}
          label={t("title")}
          status={items.length === 0 ? "empty" : "ready"}
          empty={{ title: t("empty") }}
          error={{ title: tm("notAvailable") }}
          rows={shown}
          getRowKey={(r) => r.symbol}
          columns={[
            {
              key: "market",
              header: ta("cols.market"),
              cell: (r) => (
                <div>
                  <div className="text-[14.5px] font-extrabold">{marketLabel(r.symbol)}</div>
                  {r.fundName === null ? null : (
                    <div className="text-xs font-semibold text-ink-2">{r.fundName}</div>
                  )}
                </div>
              ),
            },
            {
              key: "last",
              header: t("cols.lastTrade"),
              numeric: true,
              cell: (r) => (r.lastTradeAt === null ? tm("notProvided") : ago(r.lastTradeAt, now)),
            },
            {
              key: "book",
              header: ta("cols.book"),
              cell: (r) => <BookStatusPill status={r.bookStatus} />,
            },
            {
              key: "depth",
              header: ta("cols.depth"),
              numeric: true,
              // Sổ rỗng / ngừng: độ sâu không có ý nghĩa, hiện "–" như bản phác.
              cell: (r) => <DepthPair depth={r.bookStatus === "trading" ? r.depth : null} />,
            },
          ]}
        />
      )}
      <div className="flex flex-wrap justify-between gap-2 text-[12.5px] text-ink-2">
        {more.length === 0 ? (
          <span />
        ) : (
          <span>
            {t("more", {
              count: more.length,
              names: more.map((r) => shortMarketLabel(r.symbol)).join(", "),
            })}
          </span>
        )}
        <span>{t("note")}</span>
      </div>
    </section>
  );
}
