"use client";

import type { DeskHomeView } from "@drift/shared";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { formatMoney } from "@/lib/format";

import { usedRatio } from "../bplus";

// AI Desk B+ (artboard BP-Home / BP-Phone): thẻ Mục tiêu. Lỗ cho phép = vốn × maxDrop% của goals; lỗ đã dùng =
// drawdown của Risk Center tính bằng USDC (DEC-177). Thiếu snapshot → "Not available", không hiện 0.
// Câu Desk AI (✦) dưới thước đo thêm ở mốc LLM.

export function GoalCard({ goal }: { goal: DeskHomeView["goal"] }) {
  const t = useTranslations("desk.goal");
  const change = (
    <Link href="/onboarding/goals?from=desk" className="text-sm font-bold text-accent-ink">
      {t("change")}
    </Link>
  );
  if (goal === null)
    return (
      <section
        aria-label={t("title")}
        className="flex flex-col gap-2 rounded-card border border-border bg-surface p-5"
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="m-0 text-lg font-extrabold">{t("title")}</h2>
          {change}
        </div>
        <p className="m-0 text-sm text-ink-2">{t("none")}</p>
      </section>
    );
  const limit = formatMoney(goal.limit) ?? goal.limit;
  const ratio = usedRatio(goal);
  return (
    <section
      aria-label={t("title")}
      className="flex flex-col gap-3 rounded-card border border-border bg-surface p-5"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="m-0 text-lg font-extrabold">{t("title")}</h2>
        {change}
      </div>
      <p className="m-0 hidden text-base font-bold sm:block">
        {t("line", { goal: t(`goals.${goal.goal}`), limit })}
      </p>
      <p className="m-0 text-base font-bold sm:hidden">{t("lineShort", { limit })}</p>
      {goal.used === null ? (
        <p className="m-0 text-sm text-ink-2">
          {t("usedLabel")}: <span className="text-muted">{t("notAvailable")}</span>
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          <p className="m-0 text-sm text-ink-2">
            {t("used", { used: formatMoney(goal.used) ?? goal.used, limit })}
          </p>
          <div
            role="meter"
            aria-label={t("usedLabel")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round((ratio ?? 0) * 100)}
            className="h-2 w-full overflow-hidden rounded-full bg-surface-2"
          >
            <div
              className="h-full rounded-full bg-accent"
              style={{ width: `${String(Math.round((ratio ?? 0) * 100))}%` }}
            />
          </div>
        </div>
      )}
    </section>
  );
}
