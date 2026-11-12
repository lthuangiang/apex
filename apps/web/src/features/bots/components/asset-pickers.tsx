"use client";

import { formatDecimal, fundingStatsSchema } from "@drift/shared";
import { inputClassName } from "@drift/ui";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useMemo, type InputHTMLAttributes } from "react";

import { api } from "@/lib/api";
import { formatAmount } from "@/lib/format";
import { useMarkets } from "@/lib/markets";
import { useBuilderFeeRate } from "@/lib/queries";

import type { AssetRow } from "../fields";
import {
  arbPairs,
  displayParts,
  popularFirst,
  rankArbChoices,
  type ArbChoice,
  type PickItem,
} from "../pickers";

import { Picker } from "./picker";

// Ô chọn tài sản (UI_REVIEW G4, G6). Funding Arb: một picker tài sản, chỉ tài sản có cả market Spot lẫn
// Perps đang `TRADING`; hai market tự suy ra. Rebalancing: mỗi dòng chọn tài sản Spot theo quote asset,
// không trùng giữa các dòng. Tên tài sản lấy từ tên hiển thị của SoDEX (`BTC/USDC` → BTC).

export function ArbAssetPicker({
  value,
  onChange,
  disabled,
  inputProps,
}: {
  value: string;
  onChange: (next: { asset: string; spotMarket: string; perpMarket: string }) => void;
  disabled?: boolean | undefined;
  inputProps: InputHTMLAttributes<HTMLInputElement>;
}) {
  const t = useTranslations("createBot.assetPicker");
  const markets = useMarkets();
  // Funding đã trả + volume Spot (DEC-160): tài sản thu đủ phí nhanh nhất lên đầu, kèm số liệu từng dòng.
  const funding = useQuery({
    queryKey: ["markets-funding"],
    queryFn: () => api("GET", "/api/v1/markets/funding", fundingStatsSchema),
    staleTime: 60_000,
  });
  const builderRate = useBuilderFeeRate("funding_arb");
  const pairs = useMemo(() => arbPairs(markets.data?.items ?? []), [markets.data]);
  const choices = useMemo(
    () => rankArbChoices(pairs, funding.data, builderRate),
    [pairs, funding.data, builderRate],
  );
  const rate = (c: ArbChoice) =>
    c.avg7dPct === null
      ? null
      : t("arbRate", {
          rate:
            formatDecimal(c.avg7dPct, {
              locale: "en-US",
              minimumFractionDigits: 4,
              maximumFractionDigits: 4,
            }) ?? c.avg7dPct,
          hours: String(c.intervalHours),
        });
  const items: PickItem[] = choices.map((c) => {
    const r = rate(c);
    return {
      value: c.asset,
      label: c.asset,
      keys: [c.spot.name, c.perp.name],
      group:
        funding.data === undefined ? undefined : c.fit.eligible ? t("arbFits") : t("arbOthers"),
      secondary:
        r === null
          ? t("arbNoData")
          : c.fit.breakEvenHours === null
            ? t("arbNegative", { rate: r })
            : t("arbSecondary", { rate: r, hours: String(Math.ceil(c.fit.breakEvenHours)) }),
    };
  });
  const c = choices.find((x) => x.asset === value);
  const facts =
    c === undefined
      ? []
      : [
          ...(c.positive21 === null ? [] : [t("arbPositive", { n: c.positive21 })]),
          ...(c.fit.breakEvenHours === null
            ? []
            : [t("arbBreakEven", { hours: String(Math.ceil(c.fit.breakEvenHours)) })]),
          c.spotVolume24h === null
            ? t("arbSpotVolumeNone")
            : t("arbSpotVolume", {
                volume: formatAmount(c.spotVolume24h, 0)?.text ?? c.spotVolume24h,
              }),
        ];
  return (
    <Picker
      items={items}
      value={value}
      onChange={(asset) => {
        const pair = pairs.get(asset);
        onChange({
          asset,
          spotMarket: pair?.spot.name ?? "",
          perpMarket: pair?.perp.name ?? "",
        });
      }}
      disabled={disabled}
      inputProps={inputProps}
      placeholder={t("placeholder")}
      loading={markets.isPending}
      noMatch={(q) => t("noMatch", { q })}
      sheetTitle={t("sheetTitle")}
      info={
        c === undefined ? undefined : (
          <>
            {t("arbPair", { spot: c.spot.displayName, perp: c.perp.displayName })}
            {facts.map((f) => (
              <span key={f} className="block">
                {f}
              </span>
            ))}
            <span className="block">{t("arbNote")}</span>
          </>
        )
      }
    />
  );
}

export function RebalanceAssets({
  rows,
  quoteAsset,
  onChange,
  disabled,
  label,
  hint,
  error,
}: {
  rows: AssetRow[];
  quoteAsset: string;
  onChange: (rows: AssetRow[]) => void;
  disabled?: boolean | undefined;
  label: string;
  hint: string;
  error?: string | undefined;
}) {
  const t = useTranslations("createBot.assetPicker");
  const markets = useMarkets();
  // Tài sản Spot có market với quote asset đã chọn, cộng chính quote asset (không cần market).
  const byAsset = useMemo(() => {
    const out = new Map<string, string>();
    for (const m of markets.data?.items ?? []) {
      if (m.engine !== "spot" || !m.trading) continue;
      const { base, quote } = displayParts(m);
      if (quote === quoteAsset && !out.has(base)) out.set(base, m.name);
    }
    return out;
  }, [markets.data, quoteAsset]);
  const assets = [quoteAsset, ...[...byAsset.keys()].sort(popularFirst)];

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-bold">{label}</span>
      {rows.map((r, i) => {
        const n = String(i + 1);
        const taken = new Set(rows.filter((_, j) => j !== i).map((x) => x.asset));
        const items: PickItem[] = assets
          .filter((a) => !taken.has(a))
          .map((a) => ({ value: a, label: a, keys: byAsset.has(a) ? [byAsset.get(a) ?? ""] : [] }));
        const update = (patch: Partial<AssetRow>) => {
          onChange(rows.map((x, j) => (j === i ? { ...x, ...patch } : x)));
        };
        return (
          <div key={i} className="flex items-start gap-2">
            <div className="min-w-0 flex-[1_1_60%]">
              <Picker
                items={items}
                value={r.asset}
                onChange={(a) => {
                  update({ asset: a, market: a === quoteAsset ? "" : (byAsset.get(a) ?? "") });
                }}
                disabled={disabled}
                inputProps={{ "aria-label": t("rowAsset", { n }) }}
                placeholder={t("placeholder")}
                loading={markets.isPending}
                noMatch={(q) => t("noMatch", { q })}
                sheetTitle={t("sheetTitle")}
              />
            </div>
            <div className="relative min-w-0 flex-[1_1_30%]">
              <input
                aria-label={t("rowWeight", { n })}
                className={`${inputClassName} pr-8`}
                inputMode="decimal"
                value={r.weightPct}
                disabled={disabled}
                onChange={(e) => {
                  update({ weightPct: e.target.value });
                }}
              />
              <span
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm text-muted"
              >
                %
              </span>
            </div>
            {rows.length > 2 && disabled !== true ? (
              <button
                type="button"
                aria-label={t("rowRemove", { n })}
                className="flex size-11 shrink-0 items-center justify-center rounded-control text-muted hover:bg-surface-2"
                onClick={() => {
                  onChange(rows.filter((_, j) => j !== i));
                }}
              >
                ×
              </button>
            ) : null}
          </div>
        );
      })}
      {rows.length < 10 && disabled !== true ? (
        <button
          type="button"
          className="self-start text-sm font-bold text-accent-ink"
          onClick={() => {
            onChange([...rows, { asset: "", market: "", weightPct: "" }]);
          }}
        >
          {t("add")}
        </button>
      ) : null}
      <p className="m-0 text-xs text-muted">{hint}</p>
      {error === undefined ? null : <p className="m-0 text-sm text-neg-ink">⚠ {error}</p>}
    </div>
  );
}
