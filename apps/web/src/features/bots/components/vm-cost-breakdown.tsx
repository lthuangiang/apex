"use client";

import type { BotDetail } from "@drift/shared";
import { useTranslations } from "next-intl";

// Cơ cấu chi phí của Market Making (DEC-136): phí SoDEX, builder fee, lãi / lỗ giá đã chốt, vị thế đang mở, funding,
// mỗi mục kèm tỷ lệ trên $1M khối lượng. Số âm là tiền mất, dương là tiền được.

const fmt = (v: number) => {
  const a = Math.abs(v);
  const s = a.toLocaleString("en-US", {
    minimumFractionDigits: a >= 1 ? 2 : 4,
    maximumFractionDigits: a >= 1 ? 2 : 4,
  });
  return `${v < 0 ? "−" : v > 0 ? "+" : ""}${s}`;
};

export function VmCostBreakdown({ vm }: { vm: NonNullable<BotDetail["volumeMaker"]> }) {
  const t = useTranslations("agent.vm.breakdown");
  const volume = Number(vm.volume);
  const perM = (v: number) =>
    volume > 0 ? t("perMillion", { v: Math.abs((v / volume) * 1e6).toFixed(2) }) : "—";
  const rows: { key: string; value: number }[] = [
    { key: "sodexFee", value: -Number(vm.sodexFees) },
    { key: "builderFee", value: -Number(vm.builderFees) },
    { key: "pricePnl", value: Number(vm.pricePnl) },
    { key: "openPnl", value: Number(vm.openPnl) },
    { key: "funding", value: -Number(vm.funding) },
  ];
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3">
      <h3 className="m-0 text-sm font-extrabold">{t("title")}</h3>
      <dl className="m-0 grid grid-cols-2 gap-2 tabular-nums sm:grid-cols-5">
        {rows.map((r) => (
          <div key={r.key} className="flex flex-col gap-0.5 rounded-[10px] bg-surface-2 px-3 py-2">
            <dt className="text-xs text-muted">{t(r.key)}</dt>
            <dd
              className={`m-0 text-sm font-extrabold ${
                r.value < 0 ? "text-neg-ink" : r.value > 0 ? "text-pos" : "text-ink"
              }`}
            >
              {fmt(r.value)}
            </dd>
            <dd className="m-0 text-[11px] text-muted">{perM(r.value)}</dd>
          </div>
        ))}
      </dl>
      <p className="m-0 text-xs text-ink-2">
        {t("note", { cost: vm.cost, budget: vm.costBudget })}
      </p>
    </div>
  );
}
