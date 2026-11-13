"use client";

import type { CopyPreview } from "@drift/shared";
import { Skeleton } from "@drift/ui";
import { useTranslations } from "next-intl";

import { Card } from "@/components/workspace";

import { usd } from "../format";

// "Markets we'll copy" ở bước Budget and safety (artboard CopyMarkets / CopyMarkets-Mobile, DEC-226):
// tick market, công tắc "Set per market", nút −/+ đòn bẩy, ký quỹ mỗi vị thế và khoảng cách thanh lý ước tính. Mọi số
// do server tính (`/api/v1/copy/preview` › `rows`), web chỉ hiện; thiếu dữ liệu → "Not available", không bao giờ 0.

type Row = CopyPreview["rows"][number];

export interface MarketsPick {
  /** Market đã chọn; null = mặc định (mọi market). */
  picked: readonly string[] | null;
  perMarket: boolean;
  /** Đòn bẩy người dùng đặt (per-market). */
  levs: Readonly<Record<string, number>>;
}

export const isPicked = (pick: MarketsPick, market: string) =>
  pick.picked === null || pick.picked.includes(market);

export function MarketsCard({
  rows,
  loading,
  pick,
  presetName,
  presetLeverage,
  perTrade,
  cap,
  onToggle,
  onSelectAll,
  onPerMarket,
  onLeverage,
}: {
  rows: readonly Row[];
  loading: boolean;
  pick: MarketsPick;
  presetName: string;
  presetLeverage: number;
  perTrade: string | null;
  cap: string | null;
  onToggle: (market: string) => void;
  onSelectAll: () => void;
  onPerMarket: (on: boolean) => void;
  onLeverage: (market: string, lev: number) => void;
}) {
  const t = useTranslations("copy.budget.pickMarkets");
  const tb = useTranslations("copy.budget");
  const tm = useTranslations("common.missing");
  const pickedCount = rows.filter((r) => isPicked(pick, r.market)).length;
  const someOff = pickedCount > 0 && pickedCount < rows.length;
  const noneOn = rows.length > 0 && pickedCount === 0;
  const levOf = (r: Row) =>
    pick.perMarket
      ? Math.min(Math.max(1, pick.levs[r.market] ?? r.leverage), r.maxLeverage)
      : r.leverage;

  const trades = (r: Row) =>
    r.trades30d === null ? tm("notAvailable") : t("trades", { n: r.trades30d });
  const margin = (r: Row) =>
    isPicked(pick, r.market) ? (usd(r.marginPerPosition) ?? tm("notAvailable")) : "—";
  const liq = (r: Row) =>
    !isPicked(pick, r.market)
      ? t("notCopied")
      : r.liquidationPct === null
        ? tm("notAvailable")
        : t("liq", { pct: r.liquidationPct });

  const stepper = (r: Row) => {
    const lev = levOf(r);
    const editable = pick.perMarket && isPicked(pick, r.market);
    return (
      <div className="flex items-center gap-1.5 whitespace-nowrap">
        {editable ? (
          <button
            type="button"
            aria-label={t("lower", { market: r.market })}
            disabled={lev <= 1}
            onClick={() => {
              onLeverage(r.market, lev - 1);
            }}
            className="size-11 rounded-[10px] border border-border bg-surface text-base font-extrabold text-ink disabled:opacity-40"
          >
            −
          </button>
        ) : null}
        <span className="min-w-8 text-center text-[15px] font-extrabold tabular-nums">
          {t("lev", { lev })}
        </span>
        {editable ? (
          <button
            type="button"
            aria-label={t("raise", { market: r.market })}
            disabled={lev >= r.maxLeverage}
            onClick={() => {
              onLeverage(r.market, lev + 1);
            }}
            className="size-11 rounded-[10px] border border-border bg-surface text-base font-extrabold text-ink disabled:opacity-40"
          >
            +
          </button>
        ) : null}
        <span className="text-xs text-ink-2">{t("max", { lev: r.maxLeverage })}</span>
      </div>
    );
  };

  const check = (r: Row) => (
    <input
      type="checkbox"
      checked={isPicked(pick, r.market)}
      onChange={() => {
        onToggle(r.market);
      }}
      aria-label={t("copyMarket", { market: r.market })}
      className="size-5 accent-accent"
    />
  );

  return (
    <Card title={t("title", { picked: pickedCount, total: rows.length })}>
      <div className="-mt-2 flex flex-wrap items-start justify-between gap-3">
        <p className="m-0 min-w-0 flex-[1_1_320px] text-sm text-ink-2">
          <span className="hidden sm:inline">{tb("marketsBody")}</span>
          <span className="sm:hidden">{t("bodyShort")}</span>
        </p>
        <button
          type="button"
          onClick={onSelectAll}
          className="min-h-10 rounded-[10px] border border-border bg-surface px-3 text-[13px] font-bold text-ink"
        >
          {t("selectAll")}
        </button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] bg-surface-2 px-3.5 py-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <strong className="text-sm">{t("leverage")}</strong>
          <span className="text-[13px] text-ink-2">
            {pick.perMarket
              ? t("levSummaryPer")
              : t("levSummary", { lev: presetLeverage, preset: presetName })}
          </span>
        </div>
        <label className="inline-flex min-h-tap cursor-pointer items-center gap-2.5 text-sm font-bold">
          <input
            type="checkbox"
            checked={pick.perMarket}
            onChange={(e) => {
              onPerMarket(e.target.checked);
            }}
            className="size-5 accent-accent"
          />
          <span className="hidden sm:inline">{t("perMarket")}</span>
          <span className="sm:hidden">{t("perMarketShort")}</span>
        </label>
      </div>

      {loading && rows.length === 0 ? (
        <Skeleton className="h-40 rounded-[16px]" />
      ) : (
        <>
          {/* 1440: bảng */}
          <table className="hidden w-full border-collapse overflow-hidden rounded-[16px] text-sm sm:table">
            <caption className="sr-only">{t("table")}</caption>
            <thead>
              <tr className="bg-surface-2 text-left text-xs font-bold text-ink-2">
                <th scope="col" className="px-3.5 py-2.5">
                  {t("cols.market")}
                </th>
                <th scope="col" className="px-3 py-2.5">
                  {t("cols.trades")}
                </th>
                <th scope="col" className="px-3 py-2.5">
                  {t("cols.leverage")}
                </th>
                <th scope="col" className="px-3 py-2.5">
                  {t("cols.margin")}
                </th>
                <th scope="col" className="px-3 py-2.5">
                  {t("cols.liq")}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.market}
                  className={`border-t border-border ${isPicked(pick, r.market) ? "" : "opacity-60"}`}
                >
                  <th scope="row" className="px-3.5 py-2 text-left whitespace-nowrap">
                    <label className="flex min-h-tap cursor-pointer items-center gap-2.5 text-[15px] font-bold">
                      {check(r)}
                      {r.market}
                    </label>
                  </th>
                  <td className="px-3 py-2 text-ink-2">{trades(r)}</td>
                  <td className="px-3 py-2">{stepper(r)}</td>
                  <td className="px-3 py-2 font-bold tabular-nums">{margin(r)}</td>
                  <td className="px-3 py-2 text-ink-2 tabular-nums">{liq(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* 390: mỗi market một thẻ */}
          <ul className="m-0 flex list-none flex-col gap-3 p-0 sm:hidden">
            {rows.map((r) => (
              <li
                key={r.market}
                className={`flex flex-col gap-2 rounded-[16px] border border-border p-3.5 ${
                  isPicked(pick, r.market) ? "" : "opacity-60"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <label className="flex min-h-tap cursor-pointer items-center gap-2.5 text-[15px] font-bold">
                    {check(r)}
                    {r.market}
                  </label>
                  <span className="text-sm text-ink-2">{trades(r)}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-ink-2">{t("cols.leverage")}</span>
                  {stepper(r)}
                </div>
                <dl className="m-0 grid grid-cols-2 gap-2 text-sm">
                  <div className="flex flex-col gap-0.5">
                    <dt className="text-xs font-semibold text-ink-2">{t("cols.margin")}</dt>
                    <dd className="m-0 font-bold tabular-nums">{margin(r)}</dd>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <dt className="text-xs font-semibold text-ink-2">{t("cols.liq")}</dt>
                    <dd className="m-0 tabular-nums">{liq(r)}</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="m-0 text-[13px] text-ink-2">
        {perTrade !== null && cap !== null ? (
          <>
            <span className="hidden sm:inline">
              {t("note", {
                perTrade: usd(perTrade)?.replace("$", "") ?? "",
                cap: usd(cap)?.replace("$", "") ?? "",
              })}
            </span>
            <span className="sm:hidden">{t("noteShort")}</span>
          </>
        ) : (
          t("noteShort")
        )}
      </p>

      {someOff ? (
        <div role="status" className="rounded-[14px] bg-warn-bg px-3.5 py-3 text-sm text-warn">
          <strong>{t("partTitle")}</strong>{" "}
          <span className="hidden sm:inline">{t("partBody")}</span>
          <span className="sm:hidden">{t("partBodyShort")}</span>
        </div>
      ) : null}
      {noneOn ? (
        <p role="alert" className="m-0 text-sm font-bold text-neg-ink">
          {t("none")}
        </p>
      ) : null}
    </Card>
  );
}

/** Thẻ nhỏ "What you'll copy" ở cột phải. */
export function WhatYoullCopy({
  picked,
  total,
  levs,
}: {
  picked: number;
  total: number;
  /** Đòn bẩy của các market đã chọn. */
  levs: readonly number[];
}) {
  const t = useTranslations("copy.budget.pickMarkets");
  const low = levs.length === 0 ? null : Math.min(...levs);
  const high = levs.length === 0 ? null : Math.max(...levs);
  return (
    <Card title={t("summaryTitle")}>
      <dl className="m-0 grid grid-cols-2 gap-2.5">
        <div className="rounded-[12px] bg-surface-2 p-3">
          <dt className="text-xs text-ink-2">{t("summaryMarkets")}</dt>
          <dd className="m-0 mt-1 text-lg font-extrabold tabular-nums">
            {t("count", { picked, total })}
          </dd>
        </div>
        <div className="rounded-[12px] bg-surface-2 p-3">
          <dt className="text-xs text-ink-2">{t("summaryLeverage")}</dt>
          <dd className="m-0 mt-1 text-lg font-extrabold tabular-nums">
            {low === null || high === null
              ? "—"
              : low === high
                ? t("lev", { lev: low })
                : t("levRange", { low, high })}
          </dd>
        </div>
      </dl>
    </Card>
  );
}
