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
  formatVolume,
  secToMs,
  type NumLike,
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
  weekIsLive,
} from "./public-cards";

// Rewards › SoPoints (bản phác 09): tổng điểm, tier, hạng, tuần hiện tại, weekly pool, weekly performance và cặp có hệ
// số nhân. Mọi số lấy từ SoDEX; thiếu thì "Not available" (quy tắc 8).

/**
 * `nextTierPoints` là ngưỡng tổng hay số điểm còn thiếu còn [confirm] (README bản phác, câu hỏi 3). Tới khi chốt, không
 * vẽ thanh tiến độ và không tính "còn N điểm": chỉ hiện tier kế tiếp. Chốt "ngưỡng tổng" thì trả `true`.
 */
export function nextTierPointsIsThreshold(): boolean {
  return false;
}

/** Tier của SoDEX: số (hoặc chuỗi số) thì "Tier 3"; chuỗi tên thì hiện nguyên. */
function useTierText(): (v: NumLike | null | undefined) => string | null {
  const t = useTranslations("rewards.summary");
  return (v) => {
    if (v === null || v === undefined || v === "") return null;
    const n = decimalOf(v);
    return n === null ? String(v) : t("tier", { tier: formatCount(n) ?? n });
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
  const nextPts = decimalOf(s?.nextTierPoints);
  const totalDec = decimalOf(s?.totalPoints);
  // Chỉ khi đã chốt `nextTierPoints` là ngưỡng tổng (nextTierPointsIsThreshold).
  const progress =
    nextTierPointsIsThreshold() && nextPts !== null && totalDec !== null && dec(nextPts).gt(0)
      ? {
          pct: Math.min(100, Math.max(0, dec(totalDec).div(nextPts).times(100).toNumber())),
          left: dec(nextPts).minus(totalDec),
        }
      : null;
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
          <span className="text-sm text-ink-2 tabular-nums">
            {t("base")}{" "}
            <b className="text-ink">
              <Value text={formatCount(s?.basePoints)} />
            </b>{" "}
            · {t("boost")}{" "}
            <b className="text-ink">
              <Value text={formatCount(s?.boostPoints)} />
            </b>{" "}
            · {t("referral")}{" "}
            <b className="text-ink">
              <Value text={formatCount(s?.referralPoints)} />
            </b>
          </span>
        </div>
        <div className="flex min-w-0 flex-[0_1_360px] flex-col gap-2 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <b>{t("currentTier", { tier: current ?? "" })}</b>
            {next === null ? null : (
              <span className="text-ink-2 tabular-nums">
                {progress !== null && nextPts !== null
                  ? t("nextAt", { tier: next, points: formatCount(nextPts) ?? "" })
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
                {t("toNext", { points: formatCount(progress.left.toFixed()) ?? "", tier: next })}
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
                {w !== undefined && weekIsLive(w.weekStatus) ? <LivePill /> : null}
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

function PointsStatus({ status }: { status: string | null | undefined }) {
  const t = useTranslations("rewards.performance");
  if (status === null || status === undefined || status === "") return null;
  // `CONFIRMED` = điểm đã chốt; giá trị khác ([confirm]) coi là chưa chốt.
  const confirmed = status.toUpperCase() === "CONFIRMED";
  return (
    <span
      className={`inline-flex flex-none items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-extrabold ${confirmed ? "bg-pos-bg text-pos" : "bg-warn-bg text-warn"}`}
    >
      <span
        aria-hidden="true"
        className={`size-1.5 rounded-full ${confirmed ? "bg-pos-dot" : "bg-warn-bar"}`}
      />
      {confirmed ? t("confirmed") : t("notFinal")}
    </span>
  );
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
                return (
                  <tr key={r.weekNo} className="border-b border-border">
                    <td className="px-2.5 py-3">
                      <b className="block">{r.weekName}</b>
                      <span className="text-xs text-ink-2">
                        {t("range", {
                          start: formatDay(secToMs(r.weekStartTime), tz) ?? "",
                          end: formatDay(secToMs(r.weekEndTime), tz) ?? "",
                        })}
                      </span>
                    </td>
                    <td className="px-2.5 py-3 text-right">
                      <span className="inline-flex items-center justify-end gap-2">
                        <span className={confirmed ? "font-bold" : undefined}>
                          <Value text={formatCount(r.points)} />
                        </span>
                        <PointsStatus status={r.pointsStatus} />
                      </span>
                    </td>
                    <td className="px-2.5 py-3 text-right">
                      <Value text={formatCount(r.rank)} />
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
