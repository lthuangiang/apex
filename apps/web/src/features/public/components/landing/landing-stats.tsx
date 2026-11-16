"use client";

import { builderFeeRateOf, publicStatsSchema, Strategy } from "@drift/shared";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import { api } from "@/lib/api";
import { feeLabels, formatAmount } from "@/lib/format";

// Dải số liệu dưới hero (docs/mockups/landing-mcp/Main, Mobile): volume và số bot là số thật từ /api/v1/public/stats (từ
// trước đến nay); đang tải hiện "—", lỗi hiện "Not available", không bao giờ bịa số (CLAUDE.md 1.8). Phí lấy từ
// builderFeeRateOf.

const compact = (v: string): string | null => {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${formatAmount(n.toFixed(0), 0)?.text ?? n.toFixed(0)}`;
};

export function LandingStatsStrip() {
  const t = useTranslations("landing.stats");
  const tm = useTranslations("common.missing");
  const q = useQuery({
    queryKey: ["public-stats"],
    queryFn: () => api("GET", "/api/v1/public/stats", publicStatsSchema),
    staleTime: 5 * 60_000,
  });
  const s = q.data;
  const missing = q.isError ? tm("notAvailable") : "—";
  const items: { value: string; label: string; accent: boolean }[] = [
    {
      value: s === undefined ? missing : (compact(s.totalVolume) ?? tm("notAvailable")),
      label: t("volume"),
      accent: true,
    },
    {
      value:
        s === undefined
          ? missing
          : (formatAmount(String(s.botsLaunched), 0)?.text ?? tm("notAvailable")),
      label: t("bots"),
      accent: true,
    },
    {
      value: feeLabels(builderFeeRateOf(Strategy.volumeMaker)).pct,
      label: t("mmFee"),
      accent: false,
    },
    {
      value: feeLabels(builderFeeRateOf(Strategy.volumeFarm)).pct,
      label: t("vbFee"),
      accent: false,
    },
  ];
  return (
    <section aria-label={t("label")} className="border-t border-l-line">
      <div className="mx-auto box-border grid w-full max-w-[1240px] grid-cols-2 md:grid-cols-4 md:px-8">
        {items.map((i, n) => (
          <div
            key={i.label}
            className={`flex flex-col gap-1 border-l-line px-4 py-[18px] md:py-[22px] ${n % 2 === 0 ? "border-r" : ""} ${n < 2 ? "border-b md:border-b-0" : ""} md:border-r md:last:border-r-0 ${n === 0 ? "md:pl-0" : "md:px-5"}`}
          >
            <strong
              className={`font-num text-lg font-medium md:text-[22px] ${i.accent ? "text-l-accent" : ""}`}
            >
              {i.value}
            </strong>
            <span className="text-xs text-l-muted md:text-[13px]">{i.label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
