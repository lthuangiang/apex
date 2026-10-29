"use client";

import { inputClassName } from "@drift/ui";
import { useTranslations } from "next-intl";
import { useMemo, type InputHTMLAttributes } from "react";

import { useMarkets } from "@/lib/markets";

import type { AssetRow } from "../fields";
import { arbPairs, displayParts, popularFirst, type PickItem } from "../pickers";

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
  const pairs = useMemo(() => arbPairs(markets.data?.items ?? []), [markets.data]);
  const items: PickItem[] = [...pairs.entries()]
    .sort(([a], [b]) => popularFirst(a, b))
    .map(([asset, p]) => ({
      value: asset,
      label: asset,
      keys: [p.spot.name, p.perp.name],
    }));
  const p = pairs.get(value);
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
        p === undefined
          ? undefined
          : t("arbPair", { spot: p.spot.displayName, perp: p.perp.displayName })
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
