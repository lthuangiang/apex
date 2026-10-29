"use client";

import { analystViewSchema } from "@drift/shared";
import { ComingSoonChip, inputClassName, Skeleton } from "@drift/ui";
import { useQuery } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { Card, PageHead, Workspace } from "@/components/workspace";
import { api } from "@/lib/api";

// AI Analyst (artboard "Desktop · AI Analyst", SCREENS.md mục 9.8): insight tất định từ dữ liệu thật, tách
// dữ liệu quan sát / diễn giải / việc nên kiểm tra. Hỏi đáp tự do cần mô hình ngôn ngữ chưa được duyệt → Coming soon.

export function AnalystPage() {
  const t = useTranslations("analyst");
  const te = useTranslations("common.errors");
  const q = useQuery({
    queryKey: ["analyst"],
    queryFn: () => api("GET", "/api/v1/analyst", analystViewSchema),
    refetchInterval: 60_000,
  });
  const v = q.data;
  const href = (l: NonNullable<NonNullable<typeof v>["insights"][number]["link"]>) =>
    l.kind === "portfolio"
      ? "/portfolio"
      : l.kind === "bot"
        ? `/agent/${l.botId ?? ""}`
        : `/orders${l.botId === undefined ? "" : `?botId=${l.botId}`}`;

  return (
    <Workspace current="analyst">
      <div className="flex flex-col gap-5">
        <PageHead title={t("title")} subtitle={t("subtitle")} />
        {q.isError ? (
          <p role="alert" className="m-0">
            {te("generic")}
          </p>
        ) : null}
        {/* Briefing (artboard Analyst): thẻ hero gradient, icon ✦, vòng tròn trang trí. */}
        <section
          aria-labelledby="brief-h"
          className="relative flex flex-col gap-3 overflow-hidden rounded-hero bg-hero px-6 py-6 lg:px-[30px]"
        >
          <svg
            aria-hidden="true"
            width="300"
            height="300"
            viewBox="0 0 300 300"
            fill="none"
            className="pointer-events-none absolute -top-28 -right-20 opacity-60"
          >
            <circle cx="150" cy="150" r="70" className="stroke-surface" strokeWidth="1.5" />
            <circle cx="150" cy="150" r="115" className="stroke-surface" strokeWidth="1.5" />
          </svg>
          <div className="relative flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="flex size-10 items-center justify-center rounded-[13px] bg-surface text-accent"
            >
              <Sparkles size={20} />
            </span>
            <h2 id="brief-h" className="m-0 text-xl font-extrabold">
              {t("briefing")}
            </h2>
          </div>
          {q.isPending ? (
            <Skeleton className="relative h-12 w-full" />
          ) : (
            <p className="relative m-0 max-w-[760px] text-base leading-relaxed text-ink-body">
              {v?.briefing ?? t("noBriefing")}
            </p>
          )}
          {v === undefined ? null : (
            <span className="relative text-xs font-semibold text-ink-2 tabular-nums">
              {v.basis}
            </span>
          )}
        </section>

        <section aria-labelledby="insights" className="flex flex-col gap-3">
          <h2 id="insights" className="m-0 text-lg font-extrabold">
            {t("insights")}
          </h2>
          {v?.insights.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-card border border-border bg-surface px-6 py-10 text-center">
              <span
                aria-hidden="true"
                className="flex size-12 items-center justify-center rounded-[14px] bg-accent-tint text-accent-ink"
              >
                <Sparkles size={24} />
              </span>
              <strong className="text-base">{t("noInsightsTitle")}</strong>
              <p className="m-0 max-w-md text-sm text-ink-2">{t("noInsights")}</p>
            </div>
          ) : null}
          {(v?.insights ?? []).map((i) => (
            <article
              key={i.id}
              aria-label={i.title}
              className="flex flex-col gap-4 rounded-card border border-border bg-surface px-[22px] py-5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2.5">
                <h3 className="m-0 text-[17px] font-extrabold">{i.title}</h3>
                <span className="rounded-full bg-accent-tint px-2.5 py-1 text-xs font-bold text-accent-ink">
                  {i.subject}
                </span>
              </div>
              {i.attention ? (
                <span className="self-start rounded-full bg-warn-bg px-2.5 py-1 text-xs font-bold text-warn">
                  {t("attention")}
                </span>
              ) : null}
              <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3 text-sm">
                <div className="flex flex-col gap-1.5 rounded-[16px] bg-surface-2 px-4 py-3.5">
                  <dt className="text-[11px] font-extrabold tracking-[0.08em] text-ink-2 uppercase">
                    {t("observed")}
                  </dt>
                  <dd className="m-0 leading-normal tabular-nums">{i.observed}</dd>
                </div>
                <div className="flex flex-col gap-1.5 rounded-[16px] bg-surface-2 px-4 py-3.5">
                  <dt className="text-[11px] font-extrabold tracking-[0.08em] text-ink-2 uppercase">
                    {t("interpretation")}
                  </dt>
                  <dd className="m-0 leading-normal">{i.interpretation}</dd>
                </div>
                <div className="flex flex-col gap-1.5 rounded-[16px] border border-accent-tint bg-accent-tint/60 px-4 py-3.5">
                  <dt className="text-[11px] font-extrabold tracking-[0.08em] text-accent-ink uppercase">
                    {t("check")}
                  </dt>
                  <dd className="m-0 leading-normal">{i.check}</dd>
                </div>
              </dl>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-muted">{t("sources", { sources: i.sources })}</span>
                {i.link === null ? null : (
                  <Link
                    href={href(i.link)}
                    className="flex min-h-10 items-center rounded-control bg-accent-tint px-3.5 text-sm font-bold text-accent-ink no-underline"
                  >
                    {t(`open.${i.link.kind}`)}
                  </Link>
                )}
              </div>
            </article>
          ))}
          {v?.notEnough == null ? null : (
            <article className="flex flex-col gap-1 rounded-card border border-dashed border-border-input bg-bg p-5 text-sm">
              <strong>{t("notEnough")}</strong>
              <span>{v.notEnough.observed}</span>
              <span className="text-xs text-muted">{v.notEnough.progress}</span>
            </article>
          )}
        </section>

        <Card title={t("ask")}>
          <div className="flex flex-wrap items-center gap-2">
            <input
              aria-label={t("question")}
              className={inputClassName}
              disabled
              placeholder={t("question")}
            />
            <ComingSoonChip label={t("askSoon")} />
          </div>
          <span className="text-xs text-muted">{t("askNote")}</span>
        </Card>
        <p className="m-0 text-xs text-muted">{t("disclaimer")}</p>
      </div>
    </Workspace>
  );
}
