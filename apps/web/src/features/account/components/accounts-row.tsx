"use client";

import { dec, type PortfolioView } from "@drift/shared";
import { PnLValue } from "@drift/ui";
import { useTranslations } from "next-intl";

import { formatAmount, formatMoney } from "@/lib/format";
import { useMarketNames } from "@/lib/markets";

import { Meter } from "./charts";

// Hàng "Accounts" của Portfolio (UI_REVIEW I3, DEC-58): số dư tách theo engine. Bot Spot chỉ dùng ví Spot, bot
// Perps chỉ dùng margin Perps. Mọi số lấy nguyên từ SoDEX; `av` là giá trị theo index (chưa haircut), `am` là
// margin dùng được cho Cross (đã haircut theo collateral ratio), `ami` chỉ USDC cho Isolated.

const DOCS = "https://sodex.com/documentation/trading-mechanics/multi-asset-margin";
const usd = (v: string | null) => (v === null ? "—" : `${formatMoney(v) ?? v} USDC`);

export function negativeUsdc(pf: PortfolioView | null): string | null {
  const usdc = pf?.accounts.perps?.collateral.find((c) => c.asset === "vUSDC");
  return usdc !== undefined && dec(usdc.balance).lt(0) ? usdc.balance : null;
}

export function AccountsRow({ pf }: { pf: PortfolioView | null }) {
  const t = useTranslations("portfolio.accounts");
  const names = useMarketNames();
  if (pf === null) return null;
  const { spot, perps } = pf.accounts;
  const row = (label: string, value: React.ReactNode) => (
    <div className="flex justify-between gap-3 text-sm tabular-nums">
      <dt className="text-ink-2">{label}</dt>
      <dd className="m-0 text-right font-bold">{value}</dd>
    </div>
  );
  const haircut =
    perps === null
      ? null
      : dec(perps.accountValue).sub(perps.availableMargin).sub(perps.marginInUse);
  const negative = negativeUsdc(pf);
  return (
    <section aria-label={t("label")} className="grid gap-3.5 md:grid-cols-2">
      <div className="flex flex-col gap-3 rounded-tile border border-border bg-surface px-[18px] py-4">
        <div className="flex items-center justify-between">
          <h2 className="m-0 text-base font-extrabold">{t("spot")}</h2>
          <span className="rounded-full bg-accent-tint px-[9px] py-[3px] text-[11px] font-extrabold tracking-[0.06em] text-accent-ink">
            {t("spot")}
          </span>
        </div>
        <dl className="m-0 flex flex-col gap-2">
          {row(t("spotValue"), usd(spot.value))}
          {row(t("spotAvailable"), usd(spot.available))}
          {row(t("spotInOrders"), usd(spot.inOrders))}
        </dl>
        {spot.unpricedCoins.length === 0 ? null : (
          <span className="text-xs text-muted">
            {t("unpricedCount", { n: spot.unpricedCoins.length })}:{" "}
            {spot.unpricedCoins.map(names.asset).join(", ")}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-3 rounded-tile border border-border bg-surface px-[18px] py-4">
        <div className="flex items-center justify-between">
          <h2 className="m-0 text-base font-extrabold">{t("perps")}</h2>
          <span className="rounded-full bg-unknown-bg px-[9px] py-[3px] text-[11px] font-extrabold tracking-[0.06em] text-unknown">
            {t("perps")}
          </span>
        </div>
        {perps === null ? (
          <p className="m-0 text-sm text-ink-2">{t("perpsUnavailable")}</p>
        ) : (
          <>
            {negative === null ? null : (
              <p
                role="alert"
                className="m-0 rounded-control border border-neg-border bg-neg-soft px-3 py-2.5 text-[13px] text-neg-text"
              >
                {t("negativeUsdc", { amount: `${formatMoney(negative) ?? negative} USDC` })}
              </p>
            )}
            <dl className="m-0 flex flex-col gap-2">
              {row(t("accountValue"), usd(perps.accountValue))}
              {row(t("usableMargin"), usd(perps.availableMargin))}
              {perps.availableIsolated === null
                ? null
                : row(t("usableIsolated"), usd(perps.availableIsolated))}
              {row(t("marginInUse"), usd(perps.marginInUse))}
              {row(
                t("unrealized"),
                <PnLValue value={perps.unrealizedPnl} locale="en-US" missingLabel="—" />,
              )}
              {row(t("openPositions"), perps.openPositions)}
            </dl>
            {dec(perps.accountValue).gt(0) ? (
              <Meter
                pct={dec(perps.marginInUse).div(perps.accountValue).mul(100).toNumber()}
                label={t("marginInUse")}
              />
            ) : null}
            {!haircut?.gt("0.005") ? null : (
              <p className="m-0 text-xs text-ink-2">
                <strong>{t("haircut", { amount: formatMoney(haircut.toString()) ?? "" })}</strong> ·{" "}
                {t("haircutNote")}{" "}
                <a href={DOCS} target="_blank" rel="noreferrer" className="font-semibold">
                  {t("docs")}
                </a>
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/** Bảng collateral Perps (tab Balances): Asset · Balance · Index price · Value · Ratio · Counts as margin. */
export function CollateralTable({ pf }: { pf: PortfolioView | null }) {
  const t = useTranslations("portfolio.accounts");
  const names = useMarketNames();
  const rows = pf?.accounts.perps?.collateral ?? [];
  if (rows.length === 0) return null;
  return (
    <div className="overflow-x-auto rounded-[14px] border border-border">
      <table className="w-full min-w-[560px] border-collapse text-sm tabular-nums">
        <caption className="sr-only">{t("collateral")}</caption>
        <thead>
          <tr className="bg-surface-2 text-xs text-muted">
            <th scope="col" className="px-3.5 py-2.5 text-left font-semibold">
              {t("cols.asset")}
            </th>
            <th scope="col" className="px-3.5 py-2.5 text-right font-semibold">
              {t("cols.balance")}
            </th>
            <th scope="col" className="px-3.5 py-2.5 text-right font-semibold">
              {t("cols.index")}
            </th>
            <th scope="col" className="px-3.5 py-2.5 text-right font-semibold">
              {t("cols.value")}
            </th>
            <th scope="col" className="px-3.5 py-2.5 text-right font-semibold">
              {t("cols.ratio")}
            </th>
            <th scope="col" className="px-3.5 py-2.5 text-right font-semibold">
              {t("cols.margin")}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.asset} className="border-t border-border">
              <th scope="row" className="px-3.5 py-2.5 text-left font-bold">
                {names.asset(c.asset)}
              </th>
              <td className="px-3.5 py-2.5 text-right">{formatAmount(c.balance)?.text}</td>
              <td className="px-3.5 py-2.5 text-right">
                {c.indexPrice === null ? "—" : formatAmount(c.indexPrice, 4)?.text}
              </td>
              <td className="px-3.5 py-2.5 text-right">
                {c.value === null ? "—" : formatMoney(c.value)}
              </td>
              <td className="px-3.5 py-2.5 text-right">
                {c.collateralRatio === null
                  ? "—"
                  : `${dec(c.collateralRatio).mul(100).toString()}%`}
              </td>
              <td className="px-3.5 py-2.5 text-right font-bold">
                {c.marginValue === null ? "—" : formatMoney(c.marginValue)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
