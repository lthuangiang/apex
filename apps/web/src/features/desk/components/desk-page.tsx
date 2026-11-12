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

import { DeskAiPanel } from "./desk-ai";
import { FirstVisit } from "./first-visit";
import { GoalCard } from "./goal-card";
import { NeedsYouCard } from "./needs-you-card";
import { PaperChip } from "./paper-chip";
import { YourBots as AnalystNotes } from "./your-bots";

// AI Desk B+ (DEC-166, artboard BP-Home / BP-Phone): Needs you (tối đa 3, mỗi việc có what-if) → sức khoẻ bot. Thẻ
// Mục tiêu, thành tích, Desk AI panel (M5); "Market today" là v2 (ẩn). Tạo bot (Recommended, paper,
// DEC-105) ở /desk/new. `?tab=bots` giữ nhận xét AI Analyst của DEC-105 (màn AI Analyst chuyển user AI Desk tới đây).
// Chỉ hiện khi team bật AI Desk cho tài khoản; tắt thì quay về Overview.

type Bot = DeskHomeView["bots"][number];
type HealthKey = "healthy" | "watch" | "needs_you" | "stopped" | "paused";

function healthKey(b: Bot): HealthKey {
  if (b.state === "stopped") return "stopped";
  if (b.state === "paused" && b.health !== "needs_you") return "paused";
  return b.health;
}

// Chip theo tình trạng (artboard BP-Home): Needs you đỏ, Stopped / Paused / Watch cam, Healthy xanh.
const CHIP: Record<HealthKey, { chip: string; dot: string }> = {
  needs_you: { chip: "bg-neg-bg text-neg-ink", dot: "bg-neg" },
  stopped: { chip: "bg-warn-bg text-warn", dot: "bg-warn-bar" },
  paused: { chip: "bg-warn-bg text-warn", dot: "bg-warn-bar" },
  watch: { chip: "bg-warn-bg text-warn", dot: "bg-warn-bar" },
  healthy: { chip: "bg-pos-bg text-pos", dot: "bg-pos-dot" },
};

/** Tên hiện trên chip: trùng tên thì thêm market, vẫn trùng thì thêm 4 ký tự cuối của id bot (không phải secret). */
export function chipNames(
  bots: readonly Pick<Bot, "botId" | "name" | "market">[],
): Map<string, string> {
  const count = (key: (b: (typeof bots)[number]) => string) => {
    const m = new Map<string, number>();
    for (const b of bots) m.set(key(b), (m.get(key(b)) ?? 0) + 1);
    return m;
  };
  const byName = count((b) => b.name);
  const byMarket = count((b) => `${b.name} · ${b.market}`);
  return new Map(
    bots.map((b) => {
      if ((byName.get(b.name) ?? 0) < 2) return [b.botId, b.name];
      const withMarket = `${b.name} · ${b.market}`;
      if ((byMarket.get(withMarket) ?? 0) < 2) return [b.botId, withMarket];
      return [b.botId, `${b.name} ··${b.botId.slice(-4)}`];
    }),
  );
}

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
  const names = chipNames(bots);
  return (
    <section
      aria-labelledby="your-bots"
      className="flex flex-col gap-2.5 rounded-card border border-border bg-surface px-5 py-4.5"
    >
      <h2 id="your-bots" className="m-0 text-base font-extrabold">
        {t("yourBots")}
      </h2>
      <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
        {bots.map((b) => {
          const h = healthKey(b);
          return (
            <li key={b.botId}>
              <Link
                href={`/agent/${b.botId}`}
                title={`${b.strategy} · ${b.market}`}
                className={`inline-flex min-h-tap items-center gap-2 rounded-[14px] px-3.5 text-sm font-extrabold no-underline ${CHIP[h].chip}`}
              >
                <span
                  aria-hidden="true"
                  className={`size-2 flex-none rounded-full ${CHIP[h].dot}`}
                />
                {names.get(b.botId)} · {t(`health.${h}`)}
              </Link>
            </li>
          );
        })}
        {papers.map((p) => (
          <li key={p.bot.id}>
            <Link
              href={`/desk/paper/${p.bot.id}`}
              className="inline-flex min-h-tap items-center gap-2 rounded-[14px] bg-surface-2 px-3.5 text-sm font-extrabold text-ink no-underline"
            >
              {p.bot.name}
              <PaperChip />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Home({ v }: { v: DeskHomeView }) {
  const t = useTranslations("desk.home");
  const paper = useQuery({
    queryKey: ["desk", "bots"],
    queryFn: () => api("GET", "/api/v1/desk/bots", deskBotsViewSchema),
  });
  // Lần đầu, chưa có bot nào (thật lẫn tiền ảo): Desk AI là cửa vào (B-Empty).
  if (v.bots.length === 0 && paper.data?.paper.length === 0) return <FirstVisit />;
  // Artboard BP-Home: cột trái Mục tiêu → Needs you → Your bots; cột phải là khung chat Desk AI (dính khi cuộn).
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(340px,400px)] xl:items-start">
      <div className="flex min-w-0 flex-col gap-[18px]">
        <GoalCard goal={v.goal} items={v.items} />
        <section aria-labelledby="needs-you" className="flex min-w-0 flex-col gap-3">
          <h2 id="needs-you" className="m-0 text-[19px] font-extrabold">
            {t("needsYou", { count: v.items.length })}
          </h2>
          {v.items.length === 0 ? (
            <EmptyState title={t("nothing")} description={t("nothingBody")} />
          ) : (
            v.items.map((item) => (
              <NeedsYouCard key={item.id} item={item} checkedAt={v.checkedAt} />
            ))
          )}
        </section>
        <YourBots bots={v.bots} />
      </div>
      <div className="min-w-0 xl:sticky xl:top-5">
        <DeskAiPanel />
      </div>
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
  let live = false;
  if (q.data !== undefined) {
    const min = Math.max(0, Math.floor((Date.now() - Date.parse(q.data.checkedAt)) / 60_000));
    const ago =
      min < 1
        ? th("agoNow")
        : min < 60
          ? th("agoMinutes", { n: min })
          : th("agoHours", { n: Math.floor(min / 60) });
    const watching = q.data.bots.filter((b) => b.state !== "stopped").length;
    subtitle = watching === 0 ? th("idle", { ago }) : th("watching", { count: watching, ago });
    live = watching > 0;
  }

  return (
    <Workspace current="desk">
      <div className="flex flex-col gap-5">
        <PageHead
          title={t("title")}
          subtitle={
            q.data === undefined ? (
              subtitle
            ) : (
              <span className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className={`size-2 flex-none rounded-full ${live ? "bg-pos-dot" : "bg-muted"}`}
                />
                {subtitle}
              </span>
            )
          }
          action={
            <Link
              href="/desk/new"
              className="inline-flex min-h-tap items-center gap-1.5 rounded-[14px] border border-border-input bg-surface px-[18px] text-sm font-extrabold text-ink no-underline hover:bg-surface-2"
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
