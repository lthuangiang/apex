"use client";

import { deskBotsViewSchema, deskHomeViewSchema, type DeskHomeView } from "@drift/shared";
import { EmptyState, ErrorState, Skeleton } from "@drift/ui";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect } from "react";

import { Card, PageHead, Workspace } from "@/components/workspace";
import { api } from "@/lib/api";
import { useFeatures } from "@/lib/queries";

import { NeedsYouCard } from "./needs-you-card";
import { PaperChip } from "./paper-chip";
import { YourBots as AnalystNotes } from "./your-bots";

// AI Desk B+ (DEC-166, artboard BP-Home / BP-Phone): Needs you (tối đa 3, mỗi việc có what-if) → sức khoẻ bot. Thẻ
// Mục tiêu, thành tích và Desk AI panel thêm ở các mốc sau; "Market today" là v2 (ẩn). Tạo bot (Recommended, paper,
// DEC-105) ở /desk/new. `?tab=bots` giữ nhận xét AI Analyst của DEC-105 (màn AI Analyst chuyển user AI Desk tới đây).
// Chỉ hiện khi team bật AI Desk cho tài khoản; tắt thì quay về Overview.

type Bot = DeskHomeView["bots"][number];
type HealthKey = "healthy" | "watch" | "needs_you" | "stopped" | "paused";

function healthKey(b: Bot): HealthKey {
  if (b.state === "stopped") return "stopped";
  if (b.state === "paused" && b.health !== "needs_you") return "paused";
  return b.health;
}

const DOT: Record<HealthKey, string> = {
  healthy: "bg-pos-dot",
  watch: "bg-warn-bar",
  needs_you: "bg-neg",
  stopped: "bg-muted",
  paused: "bg-muted",
};

function YourBots({ bots }: { bots: Bot[] }) {
  const t = useTranslations("desk.home");
  const paper = useQuery({
    queryKey: ["desk", "bots"],
    queryFn: () => api("GET", "/api/v1/desk/bots", deskBotsViewSchema),
  });
  const papers = paper.data?.paper ?? [];
  if (bots.length === 0 && papers.length === 0)
    return (
      <Card title={t("yourBots")}>
        <EmptyState
          title={t("noBots")}
          description={t("noBotsBody")}
          action={
            <Link href="/desk/new" className="text-sm font-bold text-accent-ink">
              {t("startFirst")}
            </Link>
          }
        />
      </Card>
    );
  return (
    <Card title={t("yourBots")}>
      <ul className="m-0 flex list-none flex-col p-0">
        {bots.map((b) => {
          const h = healthKey(b);
          return (
            <li key={b.botId} className="border-t border-border first:border-t-0">
              <Link
                href={`/agent/${b.botId}`}
                className="flex min-h-tap items-center justify-between gap-3 py-2 text-sm"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span aria-hidden="true" className={`size-2 flex-none rounded-full ${DOT[h]}`} />
                  <span className="truncate font-bold">{b.name}</span>
                </span>
                <span className="flex-none text-ink-2">{t(`health.${h}`)}</span>
              </Link>
            </li>
          );
        })}
        {papers.map((p) => (
          <li key={p.bot.id} className="border-t border-border first:border-t-0">
            <Link
              href={`/desk/paper/${p.bot.id}`}
              className="flex min-h-tap items-center justify-between gap-3 py-2 text-sm"
            >
              <span className="truncate font-bold">{p.bot.name}</span>
              <PaperChip />
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Home({ v }: { v: DeskHomeView }) {
  const t = useTranslations("desk.home");
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(280px,360px)] lg:items-start">
      <section aria-labelledby="needs-you" className="flex min-w-0 flex-col gap-3">
        <h2 id="needs-you" className="m-0 text-lg font-extrabold">
          {t("needsYou", { count: v.items.length })}
        </h2>
        {v.items.length === 0 ? (
          <EmptyState title={t("nothing")} description={t("nothingBody")} />
        ) : (
          v.items.map((item) => <NeedsYouCard key={item.id} item={item} />)
        )}
      </section>
      <YourBots bots={v.bots} />
    </div>
  );
}

export function DeskPage() {
  const t = useTranslations("desk");
  const th = useTranslations("desk.home");
  const te = useTranslations("common.errors");
  const router = useRouter();
  const notes = useSearchParams().get("tab") === "bots";
  const features = useFeatures();
  const on = features.data?.aiDesk === true;
  useEffect(() => {
    if (features.data !== undefined && !features.data.aiDesk) router.replace("/");
  }, [features.data, router]);
  const q = useQuery({
    queryKey: ["desk", "home"],
    queryFn: () => api("GET", "/api/v1/desk/home", deskHomeViewSchema),
    enabled: on && !notes,
    refetchInterval: 60_000,
  });
  let subtitle = t("subtitle");
  if (q.data !== undefined) {
    const min = Math.max(0, Math.floor((Date.now() - Date.parse(q.data.checkedAt)) / 60_000));
    const ago =
      min < 1
        ? th("agoNow")
        : min < 60
          ? th("agoMinutes", { n: min })
          : th("agoHours", { n: Math.floor(min / 60) });
    subtitle = th("watching", { count: q.data.bots.length, ago });
  }

  return (
    <Workspace current="desk">
      <div className="flex flex-col gap-5">
        <PageHead
          title={t("title")}
          subtitle={subtitle}
          action={
            <Link
              href="/desk/new"
              className="inline-flex min-h-tap items-center gap-1.5 rounded-[12px] bg-ink px-4 text-sm font-bold text-white hover:bg-ink-2"
            >
              <Plus aria-hidden="true" size={16} />
              {th("newBot")}
            </Link>
          }
        />
        {!on ? null : notes ? (
          <AnalystNotes />
        ) : q.isPending ? (
          <div className="flex flex-col gap-4">
            <Skeleton className="h-40 w-full rounded-card" />
            <Skeleton className="h-40 w-full rounded-card" />
          </div>
        ) : q.isError ? (
          <ErrorState
            title={th("error")}
            retryLabel={te("retry")}
            onRetry={() => void q.refetch()}
          />
        ) : (
          <Home v={q.data} />
        )}
      </div>
    </Workspace>
  );
}
