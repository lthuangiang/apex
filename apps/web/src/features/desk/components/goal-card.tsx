"use client";

import { dec, deskRecordViewSchema, type DeskHomeView } from "@drift/shared";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { api } from "@/lib/api";

import { plainUsd, usedRatio } from "../bplus";

// AI Desk B+ (artboard BP-Home / BP-Phone): thẻ Mục tiêu. Lỗ cho phép = vốn × maxDrop% của goals; lỗ đã dùng =
// drawdown của Risk Center tính bằng USDC (DEC-177). Thiếu snapshot → "Not available", không hiện 0. Câu ✦ là câu mẫu
// từ việc "Needs you" (tất định, không cần LLM); không tự đánh giá "well inside your limit" vì chưa có ngưỡng.
// Lỗ đã dùng vượt giới hạn → thanh đỏ và "Over your limit" (không để thanh xanh như bình thường).

type Item = DeskHomeView["items"][number];

/** Ô ✦ của Desk AI: dấu ✦ trên nền gradient (artboard BP-Home). */
export function AiMark({ size = "md" }: { size?: "sm" | "md" }) {
  return (
    <span
      aria-hidden="true"
      className={`flex flex-none items-center justify-center bg-ai-mark text-white ${
        size === "sm"
          ? "size-[30px] rounded-[10px] text-sm"
          : "size-[34px] rounded-[11px] text-[15px]"
      }`}
    >
      ✦
    </span>
  );
}

function AiLine({ items }: { items: Item[] }) {
  const t = useTranslations("desk.goal");
  const first = items[0];
  return (
    <div className="flex items-start gap-3 rounded-[16px] bg-surface px-4 py-3.5">
      <AiMark size="sm" />
      <p className="m-0 text-[15px] leading-relaxed text-ink">
        {first === undefined
          ? t("aiNone")
          : t("aiItems", {
              count: items.length,
              bot: first.botName,
              what: t(`what.${first.rule}`),
            })}
      </p>
    </div>
  );
}

/** "My suggestions so far: 4 of 5 helped →": chỉ đếm lần đã đo xong; chưa có thì ẩn. */
function RecordLink() {
  const t = useTranslations("desk.home");
  const q = useQuery({
    queryKey: ["desk", "record"],
    queryFn: () => api("GET", "/api/v1/desk/record", deskRecordViewSchema),
  });
  const c = q.data?.counts;
  const total = c === undefined ? 0 : c.helped + c.madeWorse + c.noClearEffect;
  if (c === undefined || total === 0) return null;
  return (
    <Link
      href="/desk/record"
      className="inline-flex min-h-9 items-center self-start rounded-full bg-surface/75 px-3 text-sm font-bold text-ink no-underline hover:bg-surface"
    >
      {t("record", { helped: c.helped, total })}
    </Link>
  );
}

export function GoalCard({ goal, items }: { goal: DeskHomeView["goal"]; items: Item[] }) {
  const t = useTranslations("desk.goal");
  const head = (
    <div className="flex flex-wrap items-baseline justify-between gap-2.5">
      <h2 className="m-0 text-[13px] font-extrabold tracking-[0.08em] text-accent-ink uppercase">
        {t("title")}
      </h2>
      <Link href="/onboarding/goals?from=desk" className="text-sm font-bold text-accent-ink">
        {t("change")}
      </Link>
    </div>
  );
  if (goal === null)
    return (
      <section
        aria-label={t("title")}
        className="flex flex-col gap-3.5 rounded-hero bg-hero px-5 py-5 sm:px-6"
      >
        {head}
        <p className="m-0 text-sm text-ink-2">{t("none")}</p>
        <AiLine items={items} />
        <RecordLink />
      </section>
    );
  const limit = plainUsd(goal.limit);
  const ratio = usedRatio(goal) ?? 0;
  const over = goal.used !== null && dec(goal.used).gt(goal.limit);
  return (
    <section
      aria-label={t("title")}
      className="flex flex-col gap-3.5 rounded-hero bg-hero px-5 py-5 sm:px-6"
    >
      {head}
      <strong className="hidden text-[22px] leading-tight font-extrabold tracking-[-0.01em] sm:block">
        {t("line", { goal: t(`goals.${goal.goal}`), limit })}
      </strong>
      <strong className="text-lg font-extrabold sm:hidden">{t("lineShort", { limit })}</strong>
      {goal.used === null ? (
        <p className="m-0 flex justify-between text-sm font-bold">
          <span>{t("usedLabel")}</span>
          <span className="font-semibold text-muted">{t("notAvailable")}</span>
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          <p className="m-0 flex flex-wrap justify-between gap-x-3 text-sm font-bold tabular-nums">
            <span>{t("usedLabel")}</span>
            <span className={over ? "text-neg-ink" : undefined}>
              {over ? `${t("over")} · ` : ""}
              {t("usedOf", { used: plainUsd(goal.used), limit })}
            </span>
          </p>
          <div
            role="meter"
            aria-label={t("usedLabel")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(ratio * 100)}
            aria-valuetext={t("used", { used: plainUsd(goal.used), limit })}
            className="h-3.5 w-full overflow-hidden rounded-full bg-surface/70"
          >
            <div
              className={`h-full rounded-full ${over ? "bg-neg" : "bg-accent"}`}
              style={{ width: `${String(Math.round(ratio * 100))}%` }}
            />
          </div>
        </div>
      )}
      <AiLine items={items} />
      <RecordLink />
    </section>
  );
}
