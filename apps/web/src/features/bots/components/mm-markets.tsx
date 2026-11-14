"use client";

import type { MmMarketCost } from "@drift/shared";
import { BottomSheet, ErrorState, Skeleton } from "@drift/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { useMarketNames } from "@/lib/markets";

import { compactUsd, plain, signed, sortMarkets, useMmMarketCosts, type MmSort } from "../mm-cost";

// Gợi ý market cho bot Market Making ngay dưới field Contract (DEC-228): tối đa 3 market rẻ nhất có đủ dữ
// liệu và đủ sức chứa, dòng chi phí của contract đang chọn, và "Compare all markets" mở bảng đầy đủ (sheet trên mobile,
// dialog trên desktop). Chi phí ước tính cho bot của mình, số quá khứ 24 giờ, không dự báo; ≤ 0 ghi "0 or less".
// Chi phí hiện dạng khoảng: đầu dưới = chỉ phí (giá không chạy ngược), đầu trên = có cả lỗ giá thường gặp. Bảng mặc
// định ẩn market "Too little volume" và chưa đủ dữ liệu; lựa chọn giữ trong phiên.

const isZero = (cost: string) => Number(cost) <= 0;
/** Đầu trên lớn hơn đầu dưới thì hiện khoảng; bằng (PnL giá = 0) thì một số. */
const isRange = (r: MmMarketCost) =>
  r.totalCostPerMillion !== null && Number(r.totalCostPerMillion) > Number(r.feesPerMillion);
const hidden = (r: MmMarketCost) => r.tooLittleVolume || r.totalCostPerMillion === null;
/** Một số khi không có khoảng: phí, hoặc chi phí ước tính nếu thấp hơn (bot của mình có lãi từ giá). */
const single = (r: MmMarketCost) =>
  r.totalCostPerMillion !== null && Number(r.totalCostPerMillion) < Number(r.feesPerMillion)
    ? r.totalCostPerMillion
    : r.feesPerMillion;

export function MmSuggestions({
  value,
  onPick,
}: {
  /** Contract đang chọn trong form ("" khi chưa chọn). */
  value: string;
  onPick: (market: string) => void;
}) {
  const t = useTranslations("createBot.mmMarkets");
  const q = useMmMarketCosts();
  const names = useMarketNames();
  const [open, setOpen] = useState(false);
  // Hiện cả market thưa / thiếu dữ liệu trong bảng: giữ trong phiên (mở lại dialog vẫn như lần trước).
  const [showAll, setShowAll] = useState(false);
  const data = q.data;
  if (data === undefined) return null;
  const label = (m: string) => names.market(m);
  const byName = new Map(data.markets.map((m) => [m.market, m]));
  const rows = data.suggested.flatMap((m) => {
    const r = byName.get(m);
    return r === undefined || r.totalCostPerMillion === null ? [] : [r];
  });
  const current = value === "" ? undefined : byName.get(value);
  const cap = (r: MmMarketCost) => compactUsd(r.capacityPerDay) ?? "";

  return (
    <section
      aria-labelledby="mm-suggest-title"
      className="flex flex-col gap-2 rounded-[14px] bg-surface-2 px-3.5 py-3"
    >
      <h3 id="mm-suggest-title" className="m-0 text-[13px] font-extrabold">
        {t("suggestTitle")}
      </h3>
      {rows.length === 0 ? (
        <p className="m-0 text-xs text-ink-2">{t("noData")}</p>
      ) : (
        <>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {rows.map((r) => {
              const on = r.market === value;
              const cost = r.totalCostPerMillion ?? "0";
              return (
                <li key={r.market}>
                  <button
                    type="button"
                    aria-pressed={on}
                    onClick={() => {
                      onPick(r.market);
                    }}
                    className={`flex min-h-tap w-full items-center justify-between gap-2 rounded-control border px-3 text-left text-[13px] font-bold ${
                      on
                        ? "border-accent bg-accent-tint text-accent-ink"
                        : "border-border bg-surface text-ink hover:bg-surface-2"
                    }`}
                  >
                    <span className="min-w-0">
                      {isZero(cost)
                        ? t("suggestRowZero", { market: label(r.market), capacity: cap(r) })
                        : isRange(r)
                          ? t("suggestRow", {
                              market: label(r.market),
                              low: plain(r.feesPerMillion, 0) ?? "",
                              high: plain(cost, 0) ?? "",
                              capacity: cap(r),
                            })
                          : t("suggestRowOne", {
                              market: label(r.market),
                              low: plain(single(r), 0) ?? "",
                              capacity: cap(r),
                            })}
                    </span>
                    {on ? (
                      <span className="shrink-0 text-[11px] font-extrabold">{t("selected")}</span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            onClick={() => {
              setOpen(true);
            }}
            className="min-h-tap self-start text-[13px] font-bold text-accent-ink underline-offset-2 hover:underline"
          >
            {t("compare")}
          </button>
        </>
      )}
      {value === "" ? null : (
        <p className="m-0 text-xs text-ink-2">
          {current?.totalCostPerMillion == null
            ? t("hereNone")
            : isZero(current.totalCostPerMillion)
              ? t("hereZero")
              : isRange(current)
                ? t("hereRange", {
                    low: plain(current.feesPerMillion, 0) ?? "",
                    high: plain(current.totalCostPerMillion, 0) ?? "",
                  })
                : t("here", { cost: plain(single(current), 0) ?? "" })}
        </p>
      )}
      <BottomSheet
        open={open}
        onOpenChange={setOpen}
        title={t("compare")}
        description={t("subtitle")}
        closeLabel={t("close")}
        wide
      >
        <MmMarketTable
          value={value}
          showAll={showAll}
          onShowAll={setShowAll}
          onChoose={(m) => {
            onPick(m);
            setOpen(false);
          }}
        />
      </BottomSheet>
    </section>
  );
}

/** Bảng xếp hạng đầy đủ (trong "Compare all markets"). */
export function MmMarketTable({
  value,
  onChoose,
  showAll,
  onShowAll,
}: {
  value: string;
  onChoose: (market: string) => void;
  /** Hiện cả market "Too little volume" và chưa đủ dữ liệu. */
  showAll: boolean;
  onShowAll: (show: boolean) => void;
}) {
  const t = useTranslations("createBot.mmMarkets");
  const tm = useTranslations("common.missing");
  const te = useTranslations("common.errors");
  const q = useMmMarketCosts();
  const names = useMarketNames();
  const [sort, setSort] = useState<MmSort>("cost");
  const data = q.data;
  const na = tm("notAvailable");
  const label = (m: string) => names.market(m);
  const all = data === undefined ? [] : sortMarkets(data.markets, sort);
  const hiddenCount = all.filter(hidden).length;
  const rows = showAll ? all : all.filter((r) => !hidden(r));
  const cheapest = data?.suggested[0] ?? null;

  if (q.isError)
    return (
      <ErrorState
        title={t("error")}
        retryLabel={te("retry")}
        onRetry={() => {
          void q.refetch();
        }}
      />
    );
  if (data === undefined) return <Skeleton className="h-64" />;
  return (
    <div className="flex flex-col gap-3">
      <div role="group" aria-label={t("sortLabel")} className="flex gap-2">
        {(["cost", "volume"] as const).map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={sort === k}
            onClick={() => {
              setSort(k);
            }}
            className={`min-h-tap rounded-control border px-3.5 text-[13px] font-bold ${
              sort === k
                ? "border-ink bg-ink text-surface"
                : "border-border bg-surface text-ink hover:bg-surface-2"
            }`}
          >
            {t(`sort.${k}`)}
          </button>
        ))}
      </div>
      <div className="relative overflow-x-auto">
        <table className="w-full min-w-[980px] border-collapse text-sm tabular-nums">
          <thead>
            <tr className="text-left text-xs text-muted">
              {(
                [
                  "market",
                  "step",
                  "swing",
                  "volume",
                  "capacity",
                  "pnl",
                  "fees",
                  "withMoves",
                ] as const
              ).map((c) => (
                <th
                  key={c}
                  scope="col"
                  className={`py-2 pr-3 font-bold ${c === "market" ? "" : "text-right"}`}
                >
                  {t(`col.${c}`)}
                </th>
              ))}
              <th scope="col" className="py-2 text-right font-bold">
                <span className="sr-only">{t("col.choose")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const on = r.market === value;
              const badge =
                sort === "cost" && r.market === cheapest
                  ? "cheapest"
                  : r.tooLittleVolume
                    ? "tooLittle"
                    : r.yourBot
                      ? "yourBot"
                      : null;
              const pnl = signed(r.pricePnlPerMillion, 0);
              const total = r.totalCostPerMillion;
              return (
                <tr
                  key={r.market}
                  className={`border-t border-border ${on ? "bg-accent-tint" : ""}`}
                >
                  <th
                    scope="row"
                    className="py-2.5 pr-3 text-left font-extrabold whitespace-nowrap"
                  >
                    {label(r.market)}
                    {badge === null ? null : (
                      <span
                        className={`ml-1.5 rounded-full px-2 py-[3px] text-[11px] font-extrabold ${
                          badge === "cheapest"
                            ? "bg-pos-bg text-pos"
                            : badge === "tooLittle"
                              ? "bg-warn-bg text-ink"
                              : "bg-surface-2 text-ink-2"
                        }`}
                      >
                        {t(badge)}
                      </span>
                    )}
                  </th>
                  <td className="py-2.5 pr-3 text-right">
                    {r.stepBps === null ? na : t("bps", { v: plain(r.stepBps, 2) ?? "" })}
                  </td>
                  <td className="py-2.5 pr-3 text-right">
                    {r.swingBps === null ? na : t("bps", { v: plain(r.swingBps, 2) ?? "" })}
                  </td>
                  <td className="py-2.5 pr-3 text-right">{compactUsd(r.volume24h) ?? na}</td>
                  <td className="py-2.5 pr-3 text-right">{compactUsd(r.capacityPerDay) ?? na}</td>
                  <td
                    className={`py-2.5 pr-3 text-right ${
                      pnl === null || pnl === "0"
                        ? ""
                        : pnl.startsWith("−")
                          ? "text-neg-ink"
                          : "text-pos"
                    }`}
                  >
                    {pnl ?? na}
                  </td>
                  <td className="py-2.5 pr-3 text-right">{plain(r.feesPerMillion, 0)}</td>
                  <td className="py-2.5 pr-3 text-right font-extrabold">
                    {total === null ? t("notEnough") : isZero(total) ? t("zero") : plain(total, 0)}
                  </td>
                  <td className="py-2 text-right">
                    <button
                      type="button"
                      aria-label={`${t("choose")} ${label(r.market)}`}
                      onClick={() => {
                        onChoose(r.market);
                      }}
                      className="min-h-tap rounded-control border border-border bg-surface px-3.5 text-[13px] font-bold text-ink hover:bg-surface-2"
                    >
                      {t("choose")}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {hiddenCount === 0 ? null : (
        <button
          type="button"
          aria-pressed={showAll}
          onClick={() => {
            onShowAll(!showAll);
          }}
          className="min-h-tap self-start text-[13px] font-bold text-accent-ink underline-offset-2 hover:underline"
        >
          {showAll ? t("hideThin") : t("showAll", { n: hiddenCount })}
        </button>
      )}
      <p className="m-0 text-xs text-ink-2">
        {t("method")} {t("notMax")}
      </p>
    </div>
  );
}
