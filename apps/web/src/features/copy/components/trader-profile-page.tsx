"use client";

import { dec, type LeaderEventView, type TraderProfile } from "@drift/shared";
import { Button, ChecklistRow, EmptyState, ErrorState, Skeleton } from "@drift/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect } from "react";

import { Card, PageHead, Workspace } from "@/components/workspace";
import { ApiError } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { useFeatures } from "@/lib/queries";

import { useFollow, useTrader } from "../api";
import { addr, base, holdText, pctText, usd } from "../format";

import { Avatar, CopyAction, Sparkline, TagChips } from "./parts";

// Trader profile (artboard WalletStats, DEC-163): 4 chỉ số kèm một câu giải thích, checklist "good fit", thay đổi vị
// thế gộp 60 giây (không phải từng fill), "Copy future trades" kèm câu lệnh đang mở sẽ không được copy.

export function EventChange({ e, plain = false }: { e: LeaderEventView; plain?: boolean }) {
  const t = useTranslations("copy");
  const arrow = e.kind === "open" || e.kind === "add" ? (e.side === "short" ? "▼ " : "▲ ") : "";
  return (
    <span className={plain ? undefined : "font-semibold"}>
      {arrow}
      {t(`kinds.${e.kind}`, { side: e.side === null ? "" : t(`sides.${e.side}`) }).trim()}
    </span>
  );
}

function Metric({
  label,
  value,
  help,
  tone,
}: {
  label: string;
  value: string;
  help: string;
  tone?: "pos" | "neg";
}) {
  return (
    <div className="flex flex-col gap-1 rounded-card border border-border bg-surface p-5">
      <span className="text-sm font-semibold text-ink-2">{label}</span>
      <span
        className={`text-2xl font-extrabold tabular-nums ${tone === "pos" ? "text-pos" : tone === "neg" ? "text-neg" : ""}`}
      >
        {value}
      </span>
      <span className="text-xs text-muted">{help}</span>
    </div>
  );
}

function FitList({ p }: { p: TraderProfile }) {
  const t = useTranslations("copy.profile");
  return (
    <Card title={t("fitTitle")}>
      <div className="flex flex-col">
        {p.fit.map((f) => {
          const data: Record<string, string> = {
            ...f.data,
            hold: holdText(f.data.holdMs === undefined ? null : Number(f.data.holdMs)) ?? "",
            share: pctText(f.data.share ?? null) ?? "",
          };
          return (
            <ChecklistRow
              key={f.item}
              status={f.ok ? "pass" : "fail"}
              statusLabel={f.ok ? t("fitOk") : t("fitWarn")}
              label={t(`fit.${f.item}.label`, data)}
              detail={t(`fit.${f.item}.detail`, data)}
            />
          );
        })}
      </div>
    </Card>
  );
}

function Changes({ events }: { events: readonly LeaderEventView[] }) {
  const t = useTranslations("copy.profile");
  const tc = useTranslations("copy.common");
  const ts = useTranslations("copy.sides");
  const tSide = (s: LeaderEventView["side"]) => (s === null ? "" : ts(s));
  return (
    <Card title={t("changesTitle")}>
      <p className="m-0 -mt-2 text-sm text-ink-2">{t("changesSub")}</p>
      {events.length === 0 ? (
        <EmptyState title={t("noChanges")} />
      ) : (
        <div className="-mx-5 overflow-x-auto px-5">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="text-xs text-muted">
              <tr>
                <th className="py-2 font-semibold">{t("cols.when")}</th>
                <th className="py-2 font-semibold">{t("cols.change")}</th>
                <th className="py-2 font-semibold">{t("cols.market")}</th>
                <th className="py-2 text-right font-semibold">{t("cols.size")}</th>
                <th className="py-2 text-right font-semibold">{t("cols.after")}</th>
                <th className="py-2 text-right font-semibold">{t("cols.result")}</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => {
                const opening = e.kind === "open" || e.kind === "add" || e.kind === "flip";
                return (
                  <tr key={`${e.at}-${e.coin}`} className="border-t border-border">
                    <td className="py-2 whitespace-nowrap tabular-nums">{formatDateTime(e.at)}</td>
                    <td className="py-2">
                      <EventChange e={e} />
                    </td>
                    <td className="py-2">{e.market === null ? e.coin : base(e.market)}</td>
                    <td className="py-2 text-right tabular-nums">
                      {usd(opening ? e.notional : `-${e.notional}`, true)}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {dec(e.positionAfter).isZero()
                        ? t("flat")
                        : `${usd(e.positionNotional) ?? ""} ${tSide(e.side)}`}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {e.realized === null ? (
                        dec(e.positionAfter).isZero() ? (
                          tc("notAvailable")
                        ) : (
                          t("open")
                        )
                      ) : (
                        <span className={dec(e.realized).isNegative() ? "text-neg" : "text-pos"}>
                          {usd(e.realized, true)} {dec(e.realized).isNegative() ? "▼" : "▲"}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function TraderProfilePage({ address }: { address: string }) {
  const t = useTranslations("copy");
  const router = useRouter();
  const features = useFeatures();
  const q = useTrader(address);
  const follow = useFollow();
  useEffect(() => {
    if (features.data !== undefined && !features.data.aiDesk) router.replace("/");
  }, [features.data, router]);
  const p = q.data;

  return (
    <Workspace current="traders">
      <div className="flex flex-col gap-5">
        <Link href="/traders" className="self-start text-sm font-bold text-accent">
          {t("profile.back")}
        </Link>
        <PageHead
          title={t("profile.title")}
          subtitle={addr(address)}
          back={{ href: "/traders", label: t("profile.back") }}
        />
        {q.isPending ? (
          <Skeleton className="h-96 rounded-card" />
        ) : q.isError ? (
          q.error instanceof ApiError && q.error.code === "NOT_FOUND" ? (
            <EmptyState title={t("profile.notFound")} />
          ) : (
            <ErrorState
              title={t("common.loadError")}
              retryLabel={t("common.retry")}
              onRetry={() => {
                void q.refetch();
              }}
            />
          )
        ) : p === undefined ? null : (
          <>
            <section className="flex flex-col gap-4 rounded-card border border-border bg-surface p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex min-w-0 items-center gap-3">
                  <Avatar address={address} />
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="truncate text-xl font-extrabold tabular-nums">
                      {p.card.displayName ?? addr(address)}
                    </span>
                    <span className="text-xs text-muted">{t("common.hyperliquid")}</span>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    disabled={follow.isPending}
                    onClick={() => {
                      follow.mutate({ address, on: !p.card.following });
                    }}
                  >
                    {p.card.following ? t("common.following") : t("common.follow")}
                  </Button>
                  {p.copyable.ok ? (
                    <CopyAction card={p.card} label={t("profile.copyFuture")} />
                  ) : null}
                </div>
              </div>
              <TagChips card={p.card} />
              <p className="m-0 text-xs text-muted">
                {t("profile.based", {
                  fills: p.card.stats.fills,
                  history: p.card.stats.historyIncomplete
                    ? t("profile.historyIncomplete")
                    : t("profile.historyComplete"),
                  date: p.updatedOn ?? "",
                })}
              </p>
              {p.copyable.ok || p.copyable.reason === null ? null : (
                <p className="m-0 rounded-card bg-warn-bg p-3 text-sm text-warn">
                  {t(`profile.blocked.${p.copyable.reason}`)}
                </p>
              )}
            </section>

            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <Metric
                label={t("list.profit")}
                value={`${usd(p.card.stats.profit, true) ?? ""} ${dec(p.card.stats.profit).isNegative() ? "▼" : "▲"}`}
                tone={dec(p.card.stats.profit).isNegative() ? "neg" : "pos"}
                help={t("profile.profitHelp")}
              />
              <Metric
                label={t("list.worstDip")}
                value={
                  dec(p.card.stats.worstDip).isZero()
                    ? (usd("0") ?? "")
                    : `${usd(`-${p.card.stats.worstDip}`) ?? ""} ▼`
                }
                tone="neg"
                help={t("profile.dipHelp")}
              />
              <Metric
                label={t("list.typicalHold")}
                value={holdText(p.card.stats.typicalHoldMs) ?? t("common.notEnough")}
                help={t("profile.holdHelp")}
              />
              <Metric
                label={t("list.winRate")}
                value={pctText(p.card.stats.winRate) ?? t("common.notEnough")}
                help={t("profile.winHelp", {
                  wins: p.card.stats.wins,
                  total: p.card.stats.closedTrades,
                })}
              />
            </div>

            <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
              <FitList p={p} />
              <Card title={t("profile.curveTitle")}>
                <p className="m-0 -mt-2 text-sm text-ink-2">{t("profile.curveSub")}</p>
                {p.card.curve.length < 2 ? (
                  <p className="m-0 text-sm text-muted">{t("common.notAvailable")}</p>
                ) : (
                  <Sparkline
                    points={p.card.curve}
                    className="h-48 w-full"
                    label={t("profile.curveTitle")}
                  />
                )}
              </Card>
            </div>

            <Changes events={p.events} />

            <section className="flex flex-col gap-3 rounded-card border border-border bg-surface p-5 sm:flex-row sm:items-center sm:justify-between">
              <p className="m-0 text-sm">
                <strong>{t("profile.notCopied")}</strong>{" "}
                {p.openPositions.length === 0
                  ? null
                  : t("profile.notCopiedOpen", {
                      positions: p.openPositions
                        .map(
                          (o) =>
                            `${o.market === null ? o.coin : base(o.market)} ${t(`sides.${o.side}`)}`,
                        )
                        .join(", "),
                    })}
              </p>
              {p.copyable.ok ? <CopyAction card={p.card} label={t("profile.copyFuture")} /> : null}
            </section>
            <p className="m-0 text-xs text-muted">{t("common.pastShort")}</p>
          </>
        )}
      </div>
    </Workspace>
  );
}
