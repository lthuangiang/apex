"use client";

import { Star } from "lucide-react";
import { useTranslations } from "next-intl";

import { useSaveWatchlist, useWatchlist } from "@/lib/watchlist";
import { has, isFull, toggle } from "@/lib/watchlist-list";

// ☆ / ★ thêm hoặc bỏ nhanh một market khỏi Watchlist, không cần vào chế độ sửa (UI_REVIEW M2, DEC-74).
// Trạng thái ★ lấy từ backend: giữ "Saving…" tới khi PUT trả về (quy tắc 1.6).

export function WatchStar({
  market,
  engine,
  label,
}: {
  market: string;
  engine: "spot" | "perps";
  label: string;
}) {
  const t = useTranslations("createBot.marketPicker");
  const list = useWatchlist();
  const save = useSaveWatchlist();
  const items = list.data?.items;
  if (items === undefined) return null;
  const on = has(items, market);
  const full = !on && isFull(items);
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <button
        type="button"
        aria-pressed={on}
        disabled={full || save.isPending}
        aria-busy={save.isPending || undefined}
        className="inline-flex min-h-tap items-center gap-1.5 rounded-control px-2 font-bold text-accent-ink hover:bg-surface-2 disabled:cursor-not-allowed disabled:text-muted"
        onClick={() => {
          save.mutate(toggle(items, { market, engine }));
        }}
      >
        <Star aria-hidden="true" size={14} fill={on ? "currentColor" : "none"} />
        {save.isPending
          ? t("watchSaving")
          : on
            ? t("watchRemove", { market: label })
            : t("watchAdd")}
      </button>
      {full ? <span className="text-muted">{t("watchFull")}</span> : null}
      {save.isError ? (
        <span role="alert" className="text-neg-ink">
          {t("watchFailed")}
        </span>
      ) : null}
    </div>
  );
}
