"use client";

import { publicStatsSchema } from "@drift/shared";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import { api } from "@/lib/api";
import { formatAmount } from "@/lib/format";

// Dải số liệu trên Landing (DEC-148): số thật từ /api/v1/public/stats (từ trước đến nay), không có số bịa. Chưa tải
// xong hoặc lỗi thì hiện "—" thay vì số.

const compact = (v: string) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${formatAmount(n.toFixed(0), 0)?.text ?? n.toFixed(0)}`;
};

export function LandingStats({ strategies }: { strategies: number }) {
  const t = useTranslations("landing.stats");
  const q = useQuery({
    queryKey: ["public-stats"],
    queryFn: () => api("GET", "/api/v1/public/stats", publicStatsSchema),
    staleTime: 5 * 60_000,
  });
  const s = q.data;
  const items: { value: string; label: string }[] = [
    { value: s === undefined ? "—" : compact(s.totalVolume), label: t("volume") },
    {
      value: s === undefined ? "—" : (formatAmount(String(s.botsLaunched), 0)?.text ?? "—"),
      label: t("bots"),
    },
    { value: String(strategies), label: t("strategies") },
  ];
  return (
    <section
      aria-label={t("label")}
      className="mx-auto box-border grid w-full max-w-[1240px] grid-cols-[repeat(auto-fit,minmax(min(100%,200px),1fr))] items-center gap-x-8 gap-y-5 rounded-[24px] border border-border bg-surface px-[clamp(20px,4vw,56px)] py-6"
    >
      <div className="flex flex-col gap-0.5">
        <span className="text-[13px] text-ink-2">{t("builtOn")}</span>
        <strong className="text-xl font-extrabold">{t("sodex")}</strong>
      </div>
      {items.map((i) => (
        <div key={i.label} className="flex flex-col gap-0.5">
          <strong className="text-2xl font-extrabold tabular-nums">{i.value}</strong>
          <span className="text-[13px] text-ink-2">{i.label}</span>
        </div>
      ))}
    </section>
  );
}
