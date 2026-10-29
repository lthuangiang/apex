"use client";

import { dec, portfolioResponseSchema, type PortfolioView } from "@drift/shared";
import { DataTable, MetricCard, PnLValue, Skeleton } from "@drift/ui";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";

import { NotConnected } from "@/components/not-connected";
import { Card, PageHead, Workspace } from "@/components/workspace";
import { api } from "@/lib/api";
import { formatAmount, formatDateTime, formatMoney } from "@/lib/format";
import { useMarketNames, type MarketNames } from "@/lib/markets";

import { AccountsRow, CollateralTable } from "./accounts-row";
import { Meter, ShareBar } from "./charts";

// Portfolio (artboard "Portfolio" / "M-Portfolio", SCREENS.md mục 9): số dư, vị thế, exposure. Giá thanh lý chỉ
// hiện khi SoDEX trả; không tự ước tính. Giá theo tick, khối lượng theo lot, tên market / tài sản theo SoDEX
// (UI_REVIEW E1.5, E1.6).

export const PORTFOLIO_KEY = ["portfolio"] as const;

type Status = "loading" | "error" | "empty" | "ready";
type Position = PortfolioView["positions"][number];
type Tab = "positions" | "spot" | "pending";

export function usePortfolio() {
  return useQuery({
    queryKey: PORTFOLIO_KEY,
    queryFn: () => api("GET", "/api/v1/portfolio", portfolioResponseSchema),
    refetchInterval: 15_000,
  });
}

/** Số đã định dạng; khi bị làm tròn / hiện "< 0.0001" thì giá trị đầy đủ nằm ở tooltip. */
export function Amount({ value, digits }: { value: string | null; digits?: number | null }) {
  const f = formatAmount(value, digits ?? null);
  if (f === null) return null;
  return f.full === null ? <>{f.text}</> : <span title={f.full}>{f.text}</span>;
}

const pctText = (v: string | null) =>
  v === null ? null : `${dec(v).toDecimalPlaces(1).toString()}%`;

export function SummaryCards({ pf, status }: { pf: PortfolioView | null; status: Status }) {
  const t = useTranslations("portfolio");
  const tm = useTranslations("common.missing");
  const names = useMarketNames();
  const money = (v: string | null) => (v === null ? null : `${formatMoney(v) ?? ""} USDC`);
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3.5">
      <MetricCard
        label={t("equity")}
        status={status}
        value={money(pf?.equity ?? null)}
        emptyLabel={tm("notAvailable")}
        hint={
          <>
            {t("equityNote")}
            {pf === null || pf.unpriced.length === 0 ? null : (
              <span className="mt-1 block text-muted">
                {t("unpriced", { coins: pf.unpriced.map(names.asset).join(", ") })}
              </span>
            )}
            {pf === null || pf.indexPriced.length === 0 ? null : (
              <span className="mt-1 block text-muted">
                {t("indexPriced", { coins: pf.indexPriced.map(names.asset).join(", ") })}
              </span>
            )}
          </>
        }
      />
      <MetricCard
        label={t("available")}
        status={status}
        value={money(pf?.available ?? null)}
        emptyLabel={tm("notAvailable")}
        hint={
          pf?.accounts.perps == null
            ? t("availableNote")
            : t("availableSplit", {
                spot: formatMoney(pf.accounts.spot.available) ?? "",
                perps: formatMoney(pf.accounts.perps.availableMargin) ?? "",
              })
        }
      />
      <MetricCard
        label={t("unrealized", { n: pf?.positions.length ?? 0 })}
        status={status}
        value={
          pf === null ? null : (
            <PnLValue
              value={pf.unrealizedPnl}
              locale="en-US"
              missingLabel={tm("notAvailable")}
              suffix=" USDC"
            />
          )
        }
        emptyLabel={tm("notAvailable")}
        hint={t("unrealizedNote")}
      />
      <MetricCard
        label={t("margin")}
        status={status}
        value={pctText(pf?.marginInUsePct ?? null)}
        emptyLabel={tm("notAvailable")}
        hint={
          pf?.marginInUsePct == null ? undefined : (
            <span className="flex flex-col gap-1.5">
              <Meter pct={Number(pf.marginInUsePct)} label={t("margin")} />
              {pf.accounts.perps === null
                ? t("marginOf", { amount: formatMoney(pf.marginInUse) ?? "" })
                : t("marginOfPerps", {
                    pct: pctText(pf.marginInUsePct) ?? "",
                    used: formatMoney(pf.marginInUse) ?? "",
                    total: formatMoney(pf.accounts.perps.accountValue) ?? "",
                  })}
            </span>
          )
        }
      />
    </div>
  );
}

/** Hero equity + 3 ô nhỏ cho mobile (artboard M-Portfolio). */
function MobileHero({ pf, loading }: { pf: PortfolioView | null; loading: boolean }) {
  const t = useTranslations("portfolio");
  const tm = useTranslations("common.missing");
  const tile = (label: string, value: ReactNode) => (
    <div className="flex min-w-0 flex-col rounded-[12px] bg-surface/85 px-2.5 py-2">
      <span className="text-xs text-muted">{label}</span>
      <strong className="text-sm leading-tight break-words tabular-nums">{value}</strong>
    </div>
  );
  const missing = loading ? <Skeleton className="h-5 w-20" /> : tm("notAvailable");
  return (
    <section
      aria-label={t("equity")}
      className="flex flex-col gap-2.5 rounded-card bg-hero p-[18px] md:hidden"
    >
      <span className="text-[13px] font-semibold text-ink-2">
        {pf === null
          ? t("equity")
          : t("mobileEquity", { time: formatDateTime(pf.updatedAt).split(", ").at(-1) ?? "" })}
      </span>
      <div className="flex items-baseline gap-1.5 tabular-nums">
        {pf === null ? (
          <span className="text-2xl font-extrabold text-ink-2">{missing}</span>
        ) : (
          <>
            <span className="text-[32px] font-extrabold tracking-[-0.02em]">
              {formatMoney(pf.equity)}
            </span>
            <span className="text-sm font-bold text-ink-2">USDC</span>
          </>
        )}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {tile(
          t("mobileTiles.unrealized"),
          pf === null ? (
            missing
          ) : (
            <PnLValue value={pf.unrealizedPnl} locale="en-US" missingLabel={tm("notAvailable")} />
          ),
        )}
        {tile(t("mobileTiles.available"), pf === null ? missing : formatMoney(pf.available))}
        {tile(
          t("mobileTiles.margin"),
          pctText(pf?.marginInUsePct ?? null) ?? (pf === null ? missing : tm("notAvailable")),
        )}
      </div>
    </section>
  );
}

function SidePill({ side }: { side: Position["side"] }) {
  const t = useTranslations("portfolio");
  return (
    <span
      className={`inline-flex h-[26px] items-center gap-1 rounded-full px-2.5 text-xs font-bold ${side === "long" ? "bg-accent-tint text-accent-ink" : "bg-warn-bg text-warn"}`}
    >
      <span aria-hidden="true">{side === "long" ? "↗" : "↘"}</span>
      {t(`side.${side}`)}
    </span>
  );
}

function NotProvided() {
  const t = useTranslations("portfolio");
  return (
    <span className="rounded-lg border border-dashed border-border-input px-2 py-0.5 text-xs font-semibold text-muted">
      {t("notProvided")}
    </span>
  );
}

export function PortfolioPage() {
  const t = useTranslations("portfolio");
  const te = useTranslations("common.errors");
  const names = useMarketNames();
  const q = usePortfolio();
  const pf = q.data?.portfolio ?? null;
  const status: Status = q.isPending
    ? "loading"
    : q.isError
      ? "error"
      : pf === null
        ? "empty"
        : "ready";
  const [tab, setTab] = useState<Tab>("positions");
  const [search, setSearch] = useState("");
  const [side, setSide] = useState<"all" | "long" | "short">("all");

  const positions = (pf?.positions ?? []).filter((p) => {
    const s = search.trim().toLowerCase();
    return (
      (side === "all" || p.side === side) &&
      (s === "" ||
        p.market.toLowerCase().includes(s) ||
        names.market(p.market).toLowerCase().includes(s))
    );
  });
  const counts: Record<Tab, number | null> = {
    positions: pf?.positions.length ?? null,
    spot: pf?.holdings.length ?? null,
    pending: pf?.pendingOrders.count ?? null,
  };

  return (
    <Workspace current="portfolio">
      <div className="flex flex-col gap-5">
        <PageHead
          title={t("title")}
          subtitle={t("subtitle")}
          updated={
            pf === null ? null : { label: (ago) => t("updated", { time: ago }), at: pf.updatedAt }
          }
        />
        {q.isSuccess && pf === null ? <NotConnected message={t("noAccount")} /> : null}
        <div className="hidden md:block">
          <SummaryCards pf={pf} status={status} />
        </div>
        <MobileHero pf={pf} loading={q.isPending} />
        <AccountsRow pf={pf} />

        <div className="flex flex-wrap items-start gap-5">
          <Card title={t("positions")} className="flex-[3_1_620px]">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div
                role="tablist"
                aria-label={t("tabs.label")}
                className="flex w-full gap-1 rounded-[14px] bg-surface-2 p-1 md:w-auto"
              >
                {(["positions", "spot", "pending"] as const).map((k) => (
                  <button
                    key={k}
                    id={`pf-tab-${k}`}
                    type="button"
                    role="tab"
                    aria-selected={tab === k}
                    aria-controls={`pf-panel-${k}`}
                    onClick={() => {
                      setTab(k);
                    }}
                    className={`flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-[10px] px-3 text-[13px] font-bold md:min-h-9 md:flex-none ${tab === k ? "bg-ink text-surface md:bg-surface md:text-ink md:shadow-sm" : "text-ink-2"}`}
                  >
                    <span className="md:hidden">
                      {counts[k] === null
                        ? t(`mobileTabs.${k}Short`)
                        : t(`mobileTabs.${k}`, { n: counts[k] })}
                    </span>
                    <span className="hidden md:inline">{t(`tabs.${k}`)}</span>
                    {counts[k] === null ? null : (
                      <span
                        className={`hidden rounded-full px-[7px] py-px text-[11px] tabular-nums md:inline ${tab === k ? "bg-accent text-white" : "bg-border text-ink-2"}`}
                      >
                        {counts[k]}
                      </span>
                    )}
                  </button>
                ))}
              </div>
              {tab === "positions" ? (
                <div className="flex flex-wrap gap-2">
                  <label className="flex h-10 items-center gap-2 rounded-control border border-border-input px-3">
                    <span className="sr-only">{t("search")}</span>
                    <input
                      type="search"
                      placeholder={t("search")}
                      value={search}
                      onChange={(e) => {
                        setSearch(e.target.value);
                      }}
                      className="w-36 border-0 bg-transparent text-sm outline-none"
                    />
                  </label>
                  <label className="flex h-10 items-center gap-2 rounded-control border border-border-input px-3 text-[13px] text-muted">
                    {t("filterSide")}
                    <select
                      className="border-0 bg-transparent text-sm font-semibold text-ink"
                      value={side}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === "all" || v === "long" || v === "short") setSide(v);
                      }}
                    >
                      <option value="all">{t("sideAll")}</option>
                      <option value="long">{t("side.long")}</option>
                      <option value="short">{t("side.short")}</option>
                    </select>
                  </label>
                </div>
              ) : null}
            </div>

            <div id={`pf-panel-${tab}`} role="tabpanel" aria-labelledby={`pf-tab-${tab}`}>
              {tab === "positions" ? (
                <div className="flex flex-col gap-3">
                  {/* Desktop: bảng. Mobile: mỗi vị thế một thẻ (artboard M-Portfolio). */}
                  <div className="hidden md:block">
                    <DataTable
                      caption={t("tabs.positions")}
                      label={t("tabs.positions")}
                      status={status === "ready" && positions.length === 0 ? "empty" : status}
                      empty={{
                        title: (pf?.positions.length ?? 0) === 0 ? t("noPositions") : t("noMatch"),
                      }}
                      error={{
                        title: te("generic"),
                        retryLabel: te("retry"),
                        onRetry: () => {
                          void q.refetch();
                        },
                      }}
                      rows={positions}
                      getRowKey={(p) => p.market}
                      columns={positionColumns(t, names)}
                    />
                  </div>
                  <ul className="m-0 flex list-none flex-col gap-3 p-0 md:hidden">
                    {positions.length === 0 ? (
                      <li className="rounded-tile bg-surface-2 p-5 text-center text-sm font-bold">
                        {(pf?.positions.length ?? 0) === 0 ? t("noPositions") : t("noMatch")}
                      </li>
                    ) : (
                      positions.map((p) => <PositionCard key={p.market} p={p} names={names} />)
                    )}
                  </ul>
                  <p className="m-0 text-xs text-muted">{t("liqNote")}</p>
                </div>
              ) : null}

              {tab === "spot" ? (
                <div className="flex flex-col gap-3">
                  {pf?.accounts.perps == null ? null : (
                    <h3 className="m-0 text-sm font-extrabold">{t("balancesSpot")}</h3>
                  )}
                  <DataTable
                    caption={t("tabs.spot")}
                    label={t("tabs.spot")}
                    status={
                      status === "ready" && (pf?.holdings.length ?? 0) === 0 ? "empty" : status
                    }
                    empty={{ title: t("noHoldings") }}
                    error={{ title: te("generic") }}
                    rows={pf?.holdings ?? []}
                    getRowKey={(h) => h.coin}
                    columns={[
                      {
                        key: "asset",
                        header: t("balances.asset"),
                        cell: (h) => <strong>{names.asset(h.coin)}</strong>,
                      },
                      {
                        key: "total",
                        header: t("balances.total"),
                        numeric: true,
                        cell: (h) => <Amount value={h.total} />,
                      },
                      {
                        key: "available",
                        header: t("balances.available"),
                        numeric: true,
                        cell: (h) => <Amount value={h.available} />,
                      },
                      {
                        key: "inOrders",
                        header: t("balances.inOrders"),
                        numeric: true,
                        cell: (h) => <Amount value={h.inOrders} />,
                      },
                      {
                        key: "value",
                        header: t("balances.value"),
                        numeric: true,
                        cell: (h) =>
                          h.value === null ? (
                            <NotProvided />
                          ) : (
                            <strong>{formatMoney(h.value)}</strong>
                          ),
                      },
                    ]}
                  />
                  {pf?.accounts.perps == null ||
                  pf.accounts.perps.collateral.length === 0 ? null : (
                    <>
                      <h3 className="m-0 text-sm font-extrabold">{t("balancesPerps")}</h3>
                      <CollateralTable pf={pf} />
                    </>
                  )}
                </div>
              ) : null}

              {tab === "pending" ? (
                <div className="flex flex-col items-center gap-2.5 rounded-[16px] bg-surface-2 px-5 py-9 text-center">
                  <strong className="text-[15px]">
                    {pf === null || pf.pendingOrders.count === 0
                      ? t("noPending")
                      : t("pending", {
                          n: pf.pendingOrders.count,
                          amount: formatMoney(pf.pendingOrders.lockedQuote) ?? "",
                        })}
                  </strong>
                  <span className="max-w-[420px] text-[13px] text-ink-2">{t("pendingNote")}</span>
                  <Link
                    href="/orders"
                    className="flex min-h-tap items-center rounded-control bg-accent-tint px-[18px] text-sm font-bold text-accent-ink no-underline"
                  >
                    {t("openOrders")}
                  </Link>
                </div>
              ) : null}
            </div>
          </Card>

          <Exposure pf={pf} names={names} />
        </div>
      </div>
    </Workspace>
  );
}

function positionColumns(t: ReturnType<typeof useTranslations<"portfolio">>, names: MarketNames) {
  return [
    {
      key: "symbol",
      header: t("cols.symbol"),
      cell: (p: Position) => <strong>{names.market(p.market)}</strong>,
    },
    { key: "side", header: t("cols.side"), cell: (p: Position) => <SidePill side={p.side} /> },
    {
      key: "size",
      header: t("cols.size"),
      numeric: true,
      cell: (p: Position) => <Amount value={p.size} digits={names.qtyDigits(p.market)} />,
    },
    {
      key: "entry",
      header: t("cols.entry"),
      numeric: true,
      cell: (p: Position) => <Amount value={p.entryPrice} digits={names.priceDigits(p.market)} />,
    },
    {
      key: "mark",
      header: t("cols.mark"),
      numeric: true,
      cell: (p: Position) =>
        p.markPrice === null ? (
          <NotProvided />
        ) : (
          <Amount value={p.markPrice} digits={names.priceDigits(p.market)} />
        ),
    },
    {
      key: "upnl",
      header: t("cols.upnl"),
      numeric: true,
      cell: (p: Position) => (
        <PnLValue value={p.unrealizedPnl} locale="en-US" missingLabel={t("notProvided")} />
      ),
    },
    {
      key: "lev",
      header: t("cols.lev"),
      numeric: true,
      cell: (p: Position) => `${String(p.leverage)}×`,
    },
    {
      key: "liq",
      header: t("cols.liq"),
      numeric: true,
      cell: (p: Position) =>
        p.liquidationPrice === null ? (
          <NotProvided />
        ) : (
          <Amount value={p.liquidationPrice} digits={names.priceDigits(p.market)} />
        ),
    },
  ];
}

function PositionCard({ p, names }: { p: Position; names: MarketNames }) {
  const t = useTranslations("portfolio");
  const digits = names.priceDigits(p.market);
  return (
    <li className="flex flex-col gap-2.5 rounded-[20px] border border-border bg-surface p-4 text-[13px] tabular-nums">
      <div className="flex items-center justify-between gap-2">
        <strong className="text-[15px]">{names.market(p.market)}</strong>
        <span className="flex items-center gap-1.5">
          <SidePill side={p.side} />
          <span className="text-xs font-bold text-ink-2">{`${String(p.leverage)}×`}</span>
        </span>
      </div>
      <div className="flex justify-between gap-2">
        <span className="text-xs text-muted">{t("card.size")}</span>
        <strong>
          <Amount value={p.size} digits={names.qtyDigits(p.market)} />
        </strong>
      </div>
      <div className="flex justify-between gap-2">
        <span className="text-xs text-muted">{t("card.entryMark")}</span>
        <strong>
          <Amount value={p.entryPrice} digits={digits} /> →{" "}
          {p.markPrice === null ? t("notProvided") : <Amount value={p.markPrice} digits={digits} />}
        </strong>
      </div>
      <div className="flex justify-between gap-2">
        <span className="text-xs text-muted">{t("card.upnl")}</span>
        <PnLValue value={p.unrealizedPnl} locale="en-US" missingLabel={t("notProvided")} />
      </div>
      <div className="flex justify-between gap-2">
        <span className="text-xs text-muted">{t("card.liq")}</span>
        {p.liquidationPrice === null ? (
          <NotProvided />
        ) : (
          <strong>
            <Amount value={p.liquidationPrice} digits={digits} />
          </strong>
        )}
      </div>
    </li>
  );
}

/** Thẻ Exposure (artboard Portfolio): luôn hiện; không có vị thế thì trạng thái trống trong thẻ. */
function Exposure({ pf, names }: { pf: PortfolioView | null; names: MarketNames }) {
  const t = useTranslations("portfolio");
  const tm = useTranslations("common.missing");
  const exposure = (pf?.positions ?? []).filter((p) => p.notional !== null);
  const gross = exposure.reduce((s, p) => s.add(p.notional ?? "0"), dec("0"));
  const top = [...exposure].sort((a, b) => dec(b.notional ?? "0").comparedTo(a.notional ?? "0"))[0];
  return (
    <section
      aria-labelledby="exp-h"
      className="flex min-w-0 flex-[1_1_300px] flex-col gap-4 rounded-card border border-border bg-surface px-[22px] py-5"
    >
      <div className="flex flex-col gap-1">
        <h2 id="exp-h" className="m-0 text-lg font-bold">
          {t("exposure")}
        </h2>
        {exposure.length === 0 ? null : (
          <span className="text-[13px] text-muted tabular-nums">
            {t("exposureNote", { gross: formatMoney(gross.toString()) ?? "" })}
          </span>
        )}
      </div>
      {pf === null ? (
        <p className="m-0 text-sm text-ink-2">{tm("notAvailable")}</p>
      ) : exposure.length === 0 || top === undefined ? (
        <p className="m-0 rounded-tile bg-surface-2 p-5 text-center text-sm font-bold">
          {t("noPositions")}
        </p>
      ) : (
        <>
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {exposure.map((p) => (
              <li key={p.market} className="flex flex-col gap-1.5">
                <span className="flex justify-between text-[13px] tabular-nums">
                  <span className="font-bold">
                    {names.market(p.market)} · {t(`side.${p.side}`)}
                  </span>
                  <span>{formatMoney(p.notional)}</span>
                </span>
                <ShareBar
                  value={Number(p.notional)}
                  max={Number(gross.toString())}
                  short={p.side === "short"}
                />
              </li>
            ))}
          </ul>
          <div className="flex gap-3.5 text-xs font-semibold text-ink-2">
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="size-3 rounded bg-accent" />
              {t("legendLong")}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="size-3 rounded bg-warn-bar"
                style={{
                  backgroundImage:
                    "repeating-linear-gradient(45deg, transparent 0 3px, var(--color-surface) 3px 6px)",
                }}
              />
              {t("legendShort")}
            </span>
          </div>
          <div className="rounded-[14px] bg-warn-bg px-3.5 py-3 text-[13px] leading-[1.45] text-warn">
            <strong>
              {t("concentration", {
                pct: dec(top.notional ?? "0")
                  .div(gross)
                  .mul(100)
                  .toDecimalPlaces(0)
                  .toString(),
                asset: names.market(top.market),
              })}
            </strong>{" "}
            {t("concentrationNote")}
          </div>
        </>
      )}
    </section>
  );
}
