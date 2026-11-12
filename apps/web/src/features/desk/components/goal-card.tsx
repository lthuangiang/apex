"use client";

import type { DeskHomeView } from "@drift/shared";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { plainUsd, usedRatio } from "../bplus";

// AI Desk B+ (artboard BP-Home / BP-Phone): thẻ Mục tiêu. Lỗ cho phép = vốn × maxDrop% của goals; lỗ đã dùng =
// drawdown của Risk Center tính bằng USDC (DEC-177). Thiếu snapshot → "Not available", không hiện 0. Câu ✦ là câu mẫu
// từ việc "Needs you" (tất định, không cần LLM); không tự đánh giá "well inside your limit" vì chưa có ngưỡng.

type Item = DeskHomeView["items"][number];

function AiLine({ items }: { items: Item[] }) {
  const t = useTranslations("desk.goal");
  const first = items[0];
  return (
    <p className="m-0 flex gap-2 text-sm text-ink">
      <span aria-hidden="true" className="text-accent-ink">
        ✦
      </span>
      <span>
        {first === undefined
          ? t("aiNone")
          : t("aiItems", {
              count: items.length,
              bot: first.botName,
              what: t(`what.${first.rule}`),
            })}
      </span>
    </p>
  );
}

export function GoalCard({ goal, items }: { goal: DeskHomeView["goal"]; items: Item[] }) {
  const t = useTranslations("desk.goal");
  const change = (
    <Link href="/onboarding/goals?from=desk" className="text-sm font-bold text-accent-ink">
      {t("change")}
    </Link>
  );
  const head = (
    <div className="flex items-center justify-between gap-3">
      <h2 className="m-0 text-lg font-extrabold">{t("title")}</h2>
      {change}
    </div>
  );
  if (goal === null)
    return (
      <section
        aria-label={t("title")}
        className="flex flex-col gap-3 rounded-hero bg-hero p-5 sm:p-6"
      >
        {head}
        <p className="m-0 text-sm text-ink-2">{t("none")}</p>
        <AiLine items={items} />
      </section>
    );
  const limit = plainUsd(goal.limit);
  const ratio = usedRatio(goal) ?? 0;
  return (
    <section
      aria-label={t("title")}
      className="flex flex-col gap-3 rounded-hero bg-hero p-5 sm:p-6"
    >
      {head}
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
            {t("used", { used: plainUsd(goal.used), limit })}
          </p>
          <div
            role="meter"
            aria-label={t("usedLabel")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(ratio * 100)}
            className="h-2 w-full overflow-hidden rounded-full bg-surface"
          >
            <div
              className="h-full rounded-full bg-accent"
              style={{ width: `${String(Math.round(ratio * 100))}%` }}
            />
          </div>
        </div>
      )}
      <AiLine items={items} />
    </section>
  );
}
