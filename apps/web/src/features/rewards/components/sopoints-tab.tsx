"use client";

import { dec } from "@drift/shared";
import { Skeleton } from "@drift/ui";
import { useTranslations } from "next-intl";
import { useEffect, useId, useState, type ReactNode } from "react";

import {
  decimalOf,
  formatCount,
  formatDay,
  formatDayTime,
  formatRank,
  formatVolume,
  secToMs,
  weekPoints,
  weekState,
  type NumLike,
  type WeekState,
} from "../format";
import {
  useRewardsBoxes,
  useRewardsDrawEntries,
  useRewardsSummary,
  useRewardsTreasures,
  useRewardsWeekInfo,
  useRewardsWeekList,
  type RewardsSession,
} from "../queries";

import { BoxArt } from "./box-art";
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

const CHIP = "inline-flex items-center gap-1 rounded-full bg-surface/80 px-2.5 py-1";

/** Giờ hiện tại, làm mới mỗi phút (đếm ngược "Next snapshot"); render đầu là null để server và client khớp nhau. */
function useMinuteClock(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => {
      setNow(Date.now());
    }, 60_000);
    return () => {
      clearInterval(id);
    };
  }, []);
  return now;
}

function SummaryHero({ session, tz }: { session: RewardsSession; tz: string }) {
  const t = useTranslations("rewards.summary");
  const tierText = useTierText();
  const summary = useRewardsSummary(session);
  const week = useRewardsWeekInfo();
  const weeks = useRewardsWeekList(session);
  const now = useMinuteClock();
  const s = summary.data;
  const w = week.data;
  const weekLoading = week.isPending && week.fetchStatus !== "idle";
  // "Last week +{points}": điểm của tuần CONFIRMED mới nhất (như trang SoDEX); không có thì không hiện.
  const lastConfirmed = [...(weeks.data ?? [])]
    .sort((a, b) => b.weekNo - a.weekNo)
    .find((r) => weekState(r) === "confirmed");
  const lastWeek = lastConfirmed === undefined ? null : formatCount(lastConfirmed.points);
  // "Next snapshot in {d}d {h}h": tới `nextWeekStartTime` của week/info; đã qua hoặc thiếu thì không hiện.
  const untilMs = w === undefined || now === null ? null : secToMs(w.nextWeekStartTime) - now;
  const snap =
    untilMs === null || untilMs <= 0
      ? null
      : { d: Math.floor(untilMs / 86_400_000), h: Math.floor((untilMs % 86_400_000) / 3_600_000) };

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
          <span className="mt-1 flex flex-wrap gap-2 text-xs text-ink-2 tabular-nums">
            {referral === null ? null : (
              <span className={CHIP}>
                {t("referral")} <b className="text-ink">{referral}</b>
              </span>
            )}
            {lastWeek === null ? null : (
              <span className={CHIP}>{t("lastWeek", { points: lastWeek })}</span>
            )}
            {snap === null ? null : (
              <span className={CHIP}>{t("nextSnapshot", { d: snap.d, h: snap.h })}</span>
            )}
          </span>
        </div>
        <div className="flex min-w-0 flex-[0_1_360px] flex-col gap-2 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            {current === null ? (
              <b>{t("currentTier", { tier: "" })}</b>
            ) : (
              <span className="inline-flex items-center">
                <span className="sr-only">{t("currentTier", { tier: current })}</span>
                {/* Tên tier dạng pill (bản phác polish 05). */}
                <span
                  aria-hidden="true"
                  className="rounded-full bg-accent px-3 py-0.5 text-xs font-extrabold tracking-wide text-white"
                >
                  {current}
                </span>
              </span>
            )}
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
                className="h-1.5 overflow-hidden rounded-full bg-surface"
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

/** Số tuần hiện trước khi bấm "Show all weeks" (bản phác polish 05). */
export const WEEKS_SHOWN = 6;

type WeekRow = NonNullable<ReturnType<typeof useRewardsWeekList>["data"]>[number];

/** Số USD của một cột tuần; null (SoDEX chưa có) → "–" mờ (#575). */
function Money({ v }: { v: NumLike | null | undefined }) {
  const text = formatVolume(v);
  return text === null ? <NoRank /> : <>{text}</>;
}

function useWeekColumns() {
  const t = useTranslations("rewards.performance");
  return [
    { key: "spot", label: t("spotVol"), get: (r: WeekRow) => r.spotVolume },
    { key: "perps", label: t("perpsVol"), get: (r: WeekRow) => r.futuresVolume },
    { key: "tvl", label: t("wealthTvl"), get: (r: WeekRow) => r.wealthTvl },
    { key: "vault", label: t("vault"), get: (r: WeekRow) => r.vaultHolding },
    { key: "oi", label: t("oi"), get: (r: WeekRow) => r.oi },
    { key: "acct", label: t("accountValue"), get: (r: WeekRow) => r.accountValue },
  ] as const;
}

function WeekPoints({ row, bold }: { row: WeekRow; bold?: boolean }) {
  const pts = weekPoints(row);
  return (
    <span className="inline-flex items-center justify-end gap-2">
      {pts.hide ? null : (
        <span className={bold === true && pts.state === "confirmed" ? "font-bold" : undefined}>
          {pts.text ?? <NoRank />}
        </span>
      )}
      <WeekChip state={pts.state} />
    </span>
  );
}

function WeeklyPerformance({ session, tz }: { session: RewardsSession; tz: string }) {
  const t = useTranslations("rewards.performance");
  const tm = useTranslations("rewards.multipliers");
  const q = useRewardsWeekList(session);
  const cols = useWeekColumns();
  const id = useId();
  const listId = useId();
  const [all, setAll] = useState(false);
  const rows = [...(q.data ?? [])].sort((a, b) => b.weekNo - a.weekNo);
  const shown = all ? rows : rows.slice(0, WEEKS_SHOWN);
  const th = "px-2.5 py-2.5 text-xs font-semibold text-ink-2";
  const range = (r: WeekRow) =>
    t("range", {
      start: formatDay(secToMs(r.weekStartTime), tz) ?? "",
      end: formatDay(secToMs(r.weekEndTime), tz) ?? "",
    });
  return (
    // Tên vùng nằm ở khung cuộn của bảng (một landmark duy nhất cho tiêu đề này, axe landmark-unique).
    <section className={CARD}>
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
        <>
          {/* ≥ 768 px: bảng đủ cột, cuộn trong khung riêng nếu thiếu chỗ (DESIGN Responsive). */}
          <div
            role="region"
            aria-labelledby={id}
            // Vùng cuộn phải focus được bằng bàn phím (axe: scrollable-region-focusable), như DataTable.
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            className="hidden overflow-x-auto md:block"
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
                  {cols.map((c) => (
                    <th key={c.key} scope="col" className={`${th} text-right`}>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.weekNo} className="border-b border-border">
                    <td className="px-2.5 py-3">
                      <span className="flex items-center gap-2">
                        <b>{r.weekName}</b>
                        {r.isLive === true ? <LivePill /> : null}
                      </span>
                      <span className="text-xs text-ink-2">{range(r)}</span>
                    </td>
                    <td className="px-2.5 py-3 text-right">
                      <WeekPoints row={r} bold />
                    </td>
                    <td className="px-2.5 py-3 text-right">
                      {formatRank(r.rank) === null ? <NoRank /> : formatRank(r.rank)}
                    </td>
                    {cols.map((c) => (
                      <td key={c.key} className="px-2.5 py-3 text-right">
                        <Money v={c.get(r)} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* < 768 px: một thẻ mỗi tuần, đủ mọi trường trong lưới 2 cột (không cuộn ngang). */}
          <ul
            id={listId}
            aria-labelledby={id}
            className="m-0 flex list-none flex-col gap-3 p-0 md:hidden"
          >
            {shown.map((r) => (
              <li
                key={r.weekNo}
                className="flex flex-col gap-2.5 rounded-tile border border-border px-4 py-3 tabular-nums"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span className="flex flex-col">
                    <span className="flex items-center gap-2">
                      <b>{r.weekName}</b>
                      {r.isLive === true ? <LivePill /> : null}
                    </span>
                    <span className="text-xs text-ink-2">{range(r)}</span>
                  </span>
                  <WeekPoints row={r} bold />
                </div>
                <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                  <div className="flex flex-col">
                    <dt className="text-xs text-ink-2">{t("rank")}</dt>
                    <dd className="m-0 font-semibold">
                      {formatRank(r.rank) === null ? <NoRank /> : formatRank(r.rank)}
                    </dd>
                  </div>
                  {cols.map((c) => (
                    <div key={c.key} className="flex flex-col">
                      <dt className="text-xs text-ink-2">{c.label}</dt>
                      <dd className="m-0 font-semibold">
                        <Money v={c.get(r)} />
                      </dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
          {rows.length > WEEKS_SHOWN ? (
            <button
              type="button"
              aria-expanded={all}
              onClick={() => {
                setAll(!all);
              }}
              className="min-h-tap self-start text-sm font-bold text-accent-ink"
            >
              {all ? tm("showLess") : t("showAllWeeks")}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}

/** "Blind Boxes at a glance" (bản phác polish 05): box trong backpack, box chờ claim, Weekly draw. */
function BoxesGlance({
  session,
  onOpenBoxes,
}: {
  session: RewardsSession;
  onOpenBoxes: () => void;
}) {
  const t = useTranslations("rewards.performance");
  const tc = useTranslations("rewards.card");
  const tb = useTranslations("rewards.boxes");
  const boxes = useRewardsBoxes(session);
  const treasures = useRewardsTreasures(session);
  const draw = useRewardsDrawEntries(session);
  const id = useId();
  // Hình box của cấp cao nhất đang có (thứ tự byLevel của SoDEX: Common → SuperRare).
  const top = [...(boxes.data?.byLevel ?? [])].reverse().find((l) => l.count > 0)?.level ?? null;
  const d = draw.data;
  const wins = typeof d?.wins === "number" ? d.wins : null;
  return (
    <section aria-labelledby={id} className={`${CARD} h-full`}>
      <h2 id={id} className="m-0 text-lg font-extrabold">
        {t("glance")}
      </h2>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <div className="flex items-center gap-3 rounded-tile bg-surface-2 px-3 py-2.5">
          <BoxArt level={top ?? "Common"} size={40} />
          <span className="flex flex-col tabular-nums">
            <b>
              {boxes.isPending && boxes.fetchStatus !== "idle" ? (
                <Skeleton className="h-5 w-8" />
              ) : (
                <Value text={formatCount(boxes.data?.total)} />
              )}
            </b>
            <span className="text-xs text-ink-2">{tc("backpack")}</span>
          </span>
        </div>
        <div className="flex items-center gap-3 rounded-tile bg-surface-2 px-3 py-2.5">
          <BoxArt level={null} size={40} />
          <span className="flex flex-col tabular-nums">
            <b>
              {treasures.isPending && treasures.fetchStatus !== "idle" ? (
                <Skeleton className="h-5 w-8" />
              ) : (
                <Value text={formatCount(treasures.data?.total)} />
              )}
            </b>
            <span className="text-xs text-ink-2">{tc("toClaim")}</span>
          </span>
        </div>
      </div>
      {d === undefined ? null : (
        <dl className="m-0 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-sm tabular-nums">
          <dt className="text-ink-2">{tb("sub.draw")}</dt>
          <dd className="m-0 text-right font-bold">
            {tb("draw.round", { round: d.round })} · {d.status}
          </dd>
          <dt className="text-ink-2">{tb("draw.tickets")}</dt>
          <dd className="m-0 text-right font-bold">
            <Value text={formatCount(d.tickets)} />
          </dd>
          {wins === null ? null : (
            <>
              <dt className="text-ink-2">{t("won")}</dt>
              <dd className="m-0 text-right font-bold">{formatCount(wins)}</dd>
            </>
          )}
        </dl>
      )}
      <button
        type="button"
        onClick={onOpenBoxes}
        className="mt-auto flex min-h-tap items-center justify-center rounded-control bg-accent-tint text-sm font-bold text-accent-ink"
      >
        {t("openBoxes")}
      </button>
    </section>
  );
}

export function SoPointsTab({
  session,
  tz,
  onOpenBoxes,
}: {
  session: RewardsSession;
  tz: string;
  /** Chuyển sang tab Blind Boxes ("Open Blind Boxes"). */
  onOpenBoxes: () => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      <SummaryHero session={session} tz={tz} />
      {/* Bảng tuần đủ 9 cột cần cả chiều ngang; multiplier và Blind Boxes at a glance thành hàng dưới (bản phác 05). */}
      <WeeklyPerformance session={session} tz={tz} />
      <div className="grid grid-cols-1 items-stretch gap-5 lg:grid-cols-2">
        <MultipliersCard tz={tz} shown={4} />
        <BoxesGlance session={session} onOpenBoxes={onOpenBoxes} />
      </div>
    </div>
  );
}
