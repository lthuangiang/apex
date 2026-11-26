"use client";

import { dec } from "@drift/shared";
import { Skeleton } from "@drift/ui";
import { useTranslations } from "next-intl";
import { useId, type ReactNode } from "react";

import {
  decimalOf,
  formatCount,
  formatDay,
  formatDayTime,
  formatRank,
  formatVolume,
  secToMs,
  weekPoints,
  type NumLike,
  type WeekState,
} from "../format";
import {
  useRewardsSummary,
  useRewardsWeekInfo,
  useRewardsWeekList,
  type RewardsSession,
} from "../queries";

import {
  CARD,
  CardUnavailable,
  LivePill,
  MultipliersCard,
  Value,
  WeekStatusPill,
} from "./public-cards";

// Rewards › SoPoints (bản phác 09): tổng điểm, tier, hạng, tuần hiện tại, weekly pool, weekly performance và cặp có hệ
// số nhân. Mọi số lấy từ SoDEX; thiếu thì "Not available" (quy tắc 8).

/**
 * Tier của SoDEX là TÊN (DIAMOND, EPIC…; đã chốt từ dữ liệu thật 2026-11-26): hiện nguyên chuỗi SoDEX trả, không thêm
 * tiền tố.
 */
export function useTierText(): (v: NumLike | null | undefined) => string | null {
  return (v) => (v === null || v === undefined || String(v).trim() === "" ? null : String(v));
}

/**
 * `nextTierPoints` là NGƯỠNG TỔNG (đã chốt): thanh = totalPoints / nextTierPoints, còn thiếu = nextTierPoints −
 * totalPoints. Thiếu hoặc ngưỡng ≤ tổng hiện tại thì không có thanh.
 */
export function tierProgress(
  total: NumLike | null | undefined,
  threshold: NumLike | null | undefined,
): { pct: number; left: string; threshold: string } | null {
  const t = decimalOf(total);
  const n = decimalOf(threshold);
  if (t === null || n === null || !dec(n).gt(t) || !dec(n).gt(0)) return null;
  return {
    pct: Math.min(100, Math.max(0, dec(t).div(n).times(100).toNumber())),
    left: dec(n).minus(t).toFixed(),
    threshold: n,
  };
}

function Tile({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-tile bg-surface/80 px-4 py-3.5">
      <span className="text-xs font-semibold text-ink-2">{label}</span>
      <span className="flex flex-wrap items-center gap-2 text-xl font-extrabold tabular-nums">
        {value}
      </span>
      {hint === undefined ? null : <span className="text-xs text-ink-2">{hint}</span>}
    </div>
  );
}

function SummaryHero({ session, tz }: { session: RewardsSession; tz: string }) {
  const t = useTranslations("rewards.summary");
  const tierText = useTierText();
  const summary = useRewardsSummary(session);
  const week = useRewardsWeekInfo();
  const s = summary.data;
  const w = week.data;
  const weekLoading = week.isPending && week.fetchStatus !== "idle";

  if (summary.isPending && summary.fetchStatus !== "idle")
    return (
      <section
        aria-busy="true"
        className="flex flex-col gap-4 rounded-hero bg-hero p-6"
        aria-label={t("total")}
      >
        <Skeleton className="h-7 w-2/5" />
        <Skeleton className="h-4 w-3/5" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Skeleton className="h-24 rounded-tile" />
          <Skeleton className="h-24 rounded-tile" />
        </div>
      </section>
    );

  const total = formatCount(s?.totalPoints);
  const current = tierText(s?.currentTier);
  const next = tierText(s?.nextTier);
  const progress = tierProgress(s?.totalPoints, s?.nextTierPoints);
  const referral = formatCount(s?.referralPoints);
  const rank = formatCount(s?.rank);
  const totalUser = formatCount(s?.totalUser);

  return (
    <section aria-label={t("total")} className="flex flex-col gap-5 rounded-hero bg-hero p-6">
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-sm font-semibold text-ink-2">{t("total")}</span>
          <span className="text-[44px] leading-none font-extrabold tracking-[-0.02em] tabular-nums">
            <Value text={total} />
          </span>
          {/* SoDEX không trả basePoints / boostPoints (dữ liệu thật): chỉ hiện Referral khi có. */}
          {referral === null ? null : (
            <span className="text-sm text-ink-2 tabular-nums">
              {t("referral")} <b className="text-ink">{referral}</b>
            </span>
          )}
        </div>
        <div className="flex min-w-0 flex-[0_1_360px] flex-col gap-2 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <b>{t("currentTier", { tier: current ?? "" })}</b>
            {next === null ? null : (
              <span className="text-ink-2 tabular-nums">
                {progress !== null
                  ? t("nextAt", { tier: next, points: formatCount(progress.threshold) ?? "" })
                  : t("nextOnly", { tier: next })}
              </span>
            )}
          </div>
          {current === null ? (
            <span className="text-xs">
              <Value text={null} />
            </span>
          ) : null}
          {progress === null || next === null ? null : (
            <>
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(progress.pct)}
                aria-label={t("currentTier", { tier: current ?? "" })}
                className="h-2 overflow-hidden rounded-full bg-surface"
              >
                <div
                  className="h-full rounded-full bg-accent"
                  style={{ width: `${String(progress.pct)}%` }}
                />
              </div>
              <span className="text-xs text-ink-2 tabular-nums">
                {t("toNext", { points: Number(progress.left), tier: next })}
              </span>
            </>
          )}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Tile
          label={t("rank")}
          value={
            <>
              <Value text={rank} />
              {rank === null || totalUser === null ? null : (
                <span className="text-sm font-semibold text-ink-2">
                  {t("of", { total: totalUser })}
                </span>
              )}
            </>
          }
        />
        <Tile
          label={t("thisWeek")}
          value={
            weekLoading ? (
              <Skeleton className="h-7 w-24" />
            ) : (
              <>
                <Value text={w?.weekName} />
                {w === undefined ? null : <WeekStatusPill status={w.weekStatus} />}
              </>
            )
          }
        />
        <Tile
          label={t("pool")}
          value={
            weekLoading ? (
              <Skeleton className="h-7 w-28" />
            ) : (
              <Value text={formatCount(w?.weekPoolPoints)} />
            )
          }
          hint={t("poolHint")}
        />
        <Tile
          label={t("nextDistribution")}
          value={
            weekLoading ? (
              <Skeleton className="h-7 w-28" />
            ) : (
              <Value
                text={w === undefined ? null : formatDayTime(secToMs(w.distributionTime), tz)}
              />
            )
          }
          hint={
            w === undefined
              ? undefined
              : t("weekEnds", { time: formatDayTime(secToMs(w.nextWeekStartTime), tz) ?? "" })
          }
        />
      </div>
    </section>
  );
}

/** Chip trạng thái tuần: Confirmed / In progress / Snapshot done (đối chiếu trang SoDEX). */
export function WeekChip({ state }: { state: WeekState }) {
  const t = useTranslations("rewards.performance");
  if (state === "unknown") return null;
  const tone =
    state === "confirmed"
      ? "bg-pos-bg text-pos"
      : state === "live"
        ? "bg-accent-tint text-accent-ink"
        : "bg-warn-bg text-warn";
  const dot = state === "confirmed" ? "bg-pos-dot" : state === "live" ? "bg-accent" : "bg-warn-bar";
  return (
    <span
      className={`inline-flex flex-none items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-extrabold ${tone}`}
    >
      <span aria-hidden="true" className={`size-1.5 rounded-full ${dot}`} />
      {state === "confirmed"
        ? t("confirmed")
        : state === "live"
          ? t("inProgress")
          : t("snapshotDone")}
    </span>
  );
}

/** Hạng chưa có: "–" mờ (như trang SoDEX). */
export function NoRank() {
  const t = useTranslations("rewards.performance");
  return <span className="text-ink-2">{t("noRank")}</span>;
}

function WeeklyPerformance({ session, tz }: { session: RewardsSession; tz: string }) {
  const t = useTranslations("rewards.performance");
  const q = useRewardsWeekList(session);
  const id = useId();
  const rows = [...(q.data ?? [])].sort((a, b) => b.weekNo - a.weekNo);
  const th = "px-2.5 py-2.5 text-xs font-semibold text-ink-2";
  return (
    // Tên vùng nằm ở khung cuộn của bảng (một landmark duy nhất cho tiêu đề này, axe landmark-unique).
    <section className={`${CARD} flex-[2_1_520px]`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={id} className="m-0 text-[22px] leading-tight font-extrabold">
          {t("title")}
        </h2>
        <span className="text-xs text-ink-2">{t("timeZone", { tz })}</span>
      </div>
      {q.isPending && q.fetchStatus !== "idle" ? (
        <div className="flex flex-col gap-2.5">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : q.data === undefined ? (
        <CardUnavailable />
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-1 rounded-tile bg-surface-2 px-5 py-6 text-center">
          <b className="text-[15px]">{t("emptyTitle")}</b>
          <span className="text-sm text-ink-2">{t("emptyBody")}</span>
        </div>
      ) : (
        // Bảng cuộn trong khung riêng ở 390, không làm cả trang cuộn ngang (DESIGN Responsive).
        <div
          role="region"
          aria-labelledby={id}
          // Vùng cuộn phải focus được bằng bàn phím (axe: scrollable-region-focusable), như DataTable.
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
          className="overflow-x-auto"
        >
          <table className="w-full border-collapse text-sm whitespace-nowrap tabular-nums">
            <thead>
              <tr className="border-b border-border text-left">
                <th scope="col" className={th}>
                  {t("week")}
                </th>
                <th scope="col" className={`${th} text-right`}>
                  {t("points")}
                </th>
                <th scope="col" className={`${th} text-right`}>
                  {t("rank")}
                </th>
                <th scope="col" className={`${th} text-right`}>
                  {t("spot")}
                </th>
                <th scope="col" className={`${th} text-right`}>
                  {t("perps")}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const confirmed = r.pointsStatus?.toUpperCase() === "CONFIRMED";
                const pts = weekPoints(r);
                return (
                  <tr key={r.weekNo} className="border-b border-border">
                    <td className="px-2.5 py-3">
                      {/* Tuần đang chạy theo `isLive` của SoDEX (dữ liệu thật). */}
                      <span className="flex items-center gap-2">
                        <b>{r.weekName}</b>
                        {r.isLive === true ? <LivePill /> : null}
                      </span>
                      <span className="text-xs text-ink-2">
                        {t("range", {
                          start: formatDay(secToMs(r.weekStartTime), tz) ?? "",
                          end: formatDay(secToMs(r.weekEndTime), tz) ?? "",
                        })}
                      </span>
                    </td>
                    <td className="px-2.5 py-3 text-right">
                      <span className="inline-flex items-center justify-end gap-2">
                        {pts.hide ? null : (
                          <span className={confirmed ? "font-bold" : undefined}>
                            <Value text={pts.text} />
                          </span>
                        )}
                        <WeekChip state={pts.state} />
                      </span>
                    </td>
                    <td className="px-2.5 py-3 text-right">
                      {formatRank(r.rank) === null ? <NoRank /> : formatRank(r.rank)}
                    </td>
                    <td className="px-2.5 py-3 text-right">
                      <Value text={formatVolume(r.spotVolume)} />
                    </td>
                    <td className="px-2.5 py-3 text-right">
                      <Value text={formatVolume(r.futuresVolume)} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function SoPointsTab({ session, tz }: { session: RewardsSession; tz: string }) {
  return (
    <div className="flex flex-col gap-5">
      <SummaryHero session={session} tz={tz} />
      <div className="flex flex-wrap items-start gap-5">
        <WeeklyPerformance session={session} tz={tz} />
        <div className="flex min-w-0 flex-[1_1_320px] flex-col">
          <MultipliersCard tz={tz} shown={5} big />
        </div>
      </div>
    </div>
  );
}
