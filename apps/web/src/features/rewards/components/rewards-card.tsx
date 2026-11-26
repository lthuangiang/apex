"use client";

import type { LotteryJob, SopointsSummary } from "@drift/shared";
import { Skeleton } from "@drift/ui";
import { Gift, Lock } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState, type ReactNode } from "react";

import { WalletPicker } from "@/features/onboarding/components/wallet-picker";

import type { RewardsError } from "../client";
import {
  browserZone,
  formatCoefficient,
  formatCount,
  formatDayTime,
  secToMs,
  sortByCoefficient,
} from "../format";
import {
  firstRewardsError,
  useRewardsActiveJobs,
  useRewardsBoxes,
  useRewardsPause,
  useRewardsRetry,
  useRewardsSummary,
  useRewardsTreasures,
  useRewardsVolumeWeights,
  useRewardsWeekInfo,
  useRewardsWeekList,
} from "../queries";
import { useRewardsAuth } from "../use-rewards-auth";

import { Value, WeekStatusPill } from "./public-cards";
import { Banner, MismatchBanner } from "./rewards-states";
import { Spinner, useRewardsSignIn } from "./sign-in-hero";
import { PointsStatus, useTierText } from "./sopoints-tab";

// Thẻ SoDEX rewards trên Overview (phương án B, bản phác 02–06; DEC-397, #549): thay thẻ Trading Agent khi công tắc
// `sodexRewards` bật, cùng vị trí và cùng vỏ (`flex-[1_1_320px]`). Chưa ký: dữ liệu công khai + mời ký. Đã ký: điểm ·
// tier · rank, box chờ claim (chỉ số; nút Claim ở #551), box trong backpack, tuần này, phân phối kế tiếp; dòng job từ
// `jobs?active=true` (chỉ đọc). Mọi số từ SoDEX; thiếu thì "Not available".

/** Nút cuối thẻ: đúng class nút "Open agent" của thẻ Trading Agent. */
const TONAL =
  "mt-auto flex min-h-tap items-center justify-center rounded-control bg-accent-tint text-sm font-bold text-accent-ink no-underline";
const TONAL_BUTTON = `${TONAL} w-full cursor-pointer disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-ink-2`;
const LINK_SM = "self-center text-[13px] font-bold text-accent-ink no-underline";

export const ACTIVE: readonly LotteryJob["status"][] = ["submitting", "pending"];

function useZone(): string {
  const [tz, setTz] = useState("UTC");
  useEffect(() => {
    setTz(browserZone());
  }, []);
  return tz;
}

function Shell({ children }: { children: ReactNode }) {
  const t = useTranslations("rewards.card");
  return (
    <section
      aria-labelledby="rewards-card-h"
      className="flex min-w-0 flex-[1_1_320px] flex-col gap-4 rounded-card border border-border bg-surface px-6 py-[22px]"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id="rewards-card-h" className="m-0 text-lg font-bold whitespace-nowrap">
          {t("title")}
        </h2>
        <span className="text-xs text-ink-2">{t("from")}</span>
      </div>
      {children}
    </section>
  );
}

function BotBox({ big, sub, stale }: { big: ReactNode; sub: ReactNode; stale?: boolean }) {
  return (
    <div
      className={`flex items-center gap-3 rounded-[16px] bg-surface-2 p-3 ${stale === true ? "opacity-60" : ""}`}
    >
      <span
        aria-hidden="true"
        className="flex size-11 flex-none items-center justify-center rounded-[14px] bg-accent text-white"
      >
        <Gift size={22} />
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-2 text-[22px] leading-tight font-extrabold tabular-nums">
          {big}
        </span>
        <span className="truncate text-xs text-ink-2 tabular-nums">{sub}</span>
      </div>
    </div>
  );
}

function Rows({ children, stale }: { children: ReactNode; stale?: boolean }) {
  return (
    <ul
      className={`m-0 flex flex-1 list-none flex-col justify-between p-0 text-[13px] ${stale === true ? "opacity-60" : ""}`}
    >
      {children}
    </ul>
  );
}

function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <li className="flex min-h-10 items-center justify-between gap-3 border-b border-border py-2 last:border-b-0">
      <span className="text-ink-2">{label}</span>
      <span className="flex items-center gap-2 font-bold tabular-nums">{children}</span>
    </li>
  );
}

function Loading() {
  return (
    <div aria-busy="true" className="flex flex-1 flex-col gap-4">
      <div className="flex items-center gap-3 rounded-[16px] bg-surface-2 p-3">
        <Skeleton className="size-11 rounded-[14px]" />
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-5 w-3/5" />
          <Skeleton className="h-3 w-4/5" />
        </div>
      </div>
      <Skeleton className="h-36 w-full rounded-[14px]" />
    </div>
  );
}

/** Lỗi mạng / HTTP / schema hoặc lỗi nghiệp vụ: khối giữa thẻ (bản phác 06). */
function Unreachable({ error, onRetry }: { error: RewardsError; onRetry: () => void }) {
  const t = useTranslations("rewards.errors");
  const business = error.kind === "business";
  return (
    <>
      <div
        role="alert"
        className="flex flex-1 flex-col items-center justify-center gap-1 rounded-[16px] bg-surface-2 p-5 text-center text-sm"
      >
        <b>{business ? t("business") : t("network")}</b>
        <span className="text-ink-2">
          {business
            ? error.sodexMessage === null
              ? null
              : `${t("said")} “${error.sodexMessage}”`
            : t("networkBody")}
        </span>
      </div>
      {business ? null : (
        <button type="button" onClick={onRetry} className={TONAL_BUTTON}>
          {t("retry")}
        </button>
      )}
    </>
  );
}

/** 429: dải bận + nút đếm ngược (bản phác 06). Không có `retryAfter` thì không hiện số. */
function Busy({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations("rewards.errors");
  const pause = useRewardsPause();
  const s = pause.seconds;
  return (
    <>
      <Banner
        tone="err"
        alert
        title={!pause.active ? t("busyNoTime") : s === null ? t("busyNoTime") : t("busy", { s })}
      />
      {pause.active ? <p className="m-0 text-xs text-ink-2">{t("busyBody")}</p> : null}
      <button type="button" disabled={pause.active} onClick={onRetry} className={TONAL_BUTTON}>
        {pause.active && s !== null ? t("retryIn", { s }) : t("retry")}
      </button>
    </>
  );
}

function jobTitle(job: LotteryJob, t: ReturnType<typeof useTranslations<"rewards.card.job">>) {
  const kind = job.kind.toLowerCase();
  if (kind.includes("merge")) return t("merging");
  if (/treasure|claim/.test(kind)) {
    const n = job.minted?.length ?? 0;
    return n > 0 ? t("claiming", { count: n }) : t("claimingAny");
  }
  if (/open|box/.test(kind)) {
    const n = job.boxes?.length ?? 0;
    return n > 0 ? t("opening", { count: n }) : t("openingAny");
  }
  return t("other");
}

/** Dòng job (bản phác 04): job mới nhất + "+N more"; View → `/rewards?tab=boxes` (popup ở #551). */
export function JobLine({
  jobs,
  view = true,
}: {
  jobs: readonly LotteryJob[];
  /** Tab Blind Boxes: không có "View" (đang ở đúng chỗ đó; popup ở #551). */
  view?: boolean;
}) {
  const t = useTranslations("rewards.card.job");
  const active = jobs.filter((j) => ACTIVE.includes(j.status));
  const latest = active.reduce<LotteryJob | undefined>(
    (a, j) => (a === undefined || j.jobId > a.jobId ? j : a),
    undefined,
  );
  if (latest === undefined) return null;
  return (
    <div
      role="status"
      className="flex items-center gap-3 rounded-[14px] bg-accent-tint px-3 py-2.5 text-accent-ink"
    >
      <Spinner />
      <div className="flex min-w-0 flex-1 flex-col">
        <b className="truncate text-[13px]">{jobTitle(latest, t)}</b>
        <span className="truncate text-xs">
          {latest.status === "pending"
            ? t("pending", { id: latest.jobId })
            : t("submitting", { id: latest.jobId })}
        </span>
      </div>
      {active.length > 1 ? (
        <span className="flex-none text-xs font-bold">
          {t("more", { count: active.length - 1 })}
        </span>
      ) : null}
      {view ? (
        <Link href="/rewards?tab=boxes" className="flex-none text-[13px] font-bold text-accent-ink">
          {t("view")}
        </Link>
      ) : null}
    </div>
  );
}

/**
 * Mọi query của thẻ gọi một lần ở đây, không theo nhánh: chuyển chưa ký ↔ đã ký (ký xong, 401) không gỡ observer giữa
 * lúc đang đọc (gỡ hết observer thì TanStack Query huỷ request đang chạy).
 */
function useCardData(auth: Auth) {
  return {
    week: useRewardsWeekInfo(),
    weights: useRewardsVolumeWeights(),
    summary: useRewardsSummary(auth),
    treasures: useRewardsTreasures(auth),
    boxes: useRewardsBoxes(auth),
    weekList: useRewardsWeekList(auth),
    jobs: useRewardsActiveJobs(auth),
  };
}
type CardData = ReturnType<typeof useCardData>;

export function RewardsCard() {
  const auth = useRewardsAuth();
  const data = useCardData(auth);
  const signedIn = auth.signedIn && auth.master !== null;
  return signedIn ? (
    <SignedCard auth={auth} data={data} />
  ) : (
    <UnsignedCard auth={auth} data={data} />
  );
}

type Auth = ReturnType<typeof useRewardsAuth>;

/** Chưa ký (bản phác 02) và hết hạn (bản phác 05). */
function UnsignedCard({ auth, data }: { auth: Auth; data: CardData }) {
  const t = useTranslations("rewards.card");
  const tr = useTranslations("rewards");
  const tz = useZone();
  const retry = useRewardsRetry();
  const tierText = useTierText();
  const flow = useRewardsSignIn(auth);
  const { week, weights } = data;
  // Hết hạn: dữ liệu ví còn trong cache (đọc trước 401) hiện mờ, không đọc lại.
  const stale = data.summary.data;
  const staleBoxes = data.boxes.data;
  const signing = auth.phase === "signing";
  const mismatch = auth.last?.kind === "wrong_wallet" ? auth.last.connected : null;
  const error = firstRewardsError(week.error, weights.error);

  if (week.isPending && week.fetchStatus !== "idle")
    return (
      <Shell>
        <Loading />
      </Shell>
    );

  const next =
    week.data === undefined ? null : formatDayTime(secToMs(week.data.distributionTime), tz);
  const signButton = (
    <button
      type="button"
      onClick={flow.start}
      disabled={signing || auth.master === null}
      aria-busy={signing || undefined}
      className={TONAL_BUTTON}
    >
      {signing ? (
        <span className="inline-flex items-center gap-2">
          <Spinner />
          {tr("signIn.checkWallet")}
        </span>
      ) : auth.expired ? (
        tr("expired.action")
      ) : (
        tr("signIn.sign")
      )}
    </button>
  );
  const goTo = (
    <Link href="/rewards" className={LINK_SM}>
      {t("goToRewards")}
    </Link>
  );
  const picker = flow.picking ? <WalletPicker onPick={flow.pick} disabled={signing} /> : null;
  const wrong =
    mismatch === null || auth.master === null ? null : (
      <MismatchBanner connected={mismatch} master={auth.master} onChoose={flow.choose} />
    );

  if (auth.expired) {
    const points = formatCount(stale?.totalPoints);
    return (
      <Shell>
        {stale === undefined ? null : (
          <BotBox
            stale
            big={
              <>
                <Value text={points} />
                <span className="text-xs font-semibold text-ink-2">{t("points")}</span>
              </>
            }
            sub={<TierRank s={stale} tierText={tierText} />}
          />
        )}
        <Banner tone="warn" title={tr("expired.title")} body={tr("expired.body")} />
        {wrong}
        <Rows stale>
          {staleBoxes === undefined ? null : (
            <Row label={t("backpack")}>
              <Value text={formatCount(staleBoxes.total)} />
            </Row>
          )}
          <Row label={tr("week.next")}>
            <Value text={next} />
          </Row>
        </Rows>
        {picker}
        {signButton}
        {goTo}
      </Shell>
    );
  }

  if (week.data === undefined && error !== null)
    return (
      <Shell>
        {error.kind === "rate_limited" ? (
          <Busy onRetry={retry} />
        ) : (
          <Unreachable error={error} onRetry={retry} />
        )}
      </Shell>
    );

  const sorted = weights.data === undefined ? [] : sortByCoefficient(weights.data.weights);
  const top = sorted[0];
  return (
    <Shell>
      <BotBox
        big={
          <>
            <Value text={week.data?.weekName} />
            {week.data === undefined ? null : <WeekStatusPill status={week.data.weekStatus} />}
          </>
        }
        sub={
          week.data === undefined ? (
            <Value text={null} />
          ) : (
            t("weeklyPool", { points: formatCount(week.data.weekPoolPoints) ?? "" })
          )
        }
      />
      {error?.kind === "rate_limited" ? <Busy onRetry={retry} /> : null}
      <Rows>
        <Row label={tr("week.next")}>
          <Value text={next} />
        </Row>
        <Row label={t("multiplier")}>
          {top === undefined ? (
            <Value text={null} />
          ) : (
            <>
              <span className="rounded-full bg-accent-tint px-2 py-0.5 text-xs font-extrabold text-accent-ink">
                {top.symbol} {formatCoefficient(top.coefficient)}
              </span>
              {sorted.length > 1 ? (
                <span className="text-xs font-semibold text-ink-2">
                  {t("more", { count: sorted.length - 1 })}
                </span>
              ) : null}
            </>
          )}
        </Row>
        <li className="flex items-start gap-2.5 py-2">
          <span
            aria-hidden="true"
            className="flex size-7 flex-none items-center justify-center rounded-[9px] bg-surface-2 text-ink-2"
          >
            <Lock size={14} />
          </span>
          <span className="flex min-w-0 flex-col">
            <b>{t("signTitle")}</b>
            <span className="text-xs text-ink-2">{t("signBody")}</span>
          </span>
        </li>
      </Rows>
      {wrong}
      {picker}
      {auth.master === null ? null : signButton}
      {goTo}
    </Shell>
  );
}

function TierRank({
  s,
  tierText,
}: {
  s: Pick<SopointsSummary, "currentTier" | "rank" | "totalUser">;
  tierText: ReturnType<typeof useTierText>;
}) {
  const t = useTranslations("rewards.card");
  const tm = useTranslations("common.missing");
  const tier = tierText(s.currentTier);
  const rank = formatCount(s.rank);
  const total = formatCount(s.totalUser);
  const parts = [
    tier,
    rank === null ? null : total === null ? t("rank", { rank }) : t("rankOf", { rank, total }),
  ].filter((p): p is string => p !== null);
  return <>{parts.length === 0 ? tm("notAvailable") : parts.join(" · ")}</>;
}

/** Đã ký (bản phác 03), có job (04), 429 (06). */
function SignedCard({ data }: { auth: Auth; data: CardData }) {
  const t = useTranslations("rewards.card");
  const tr = useTranslations("rewards");
  const tz = useZone();
  const retry = useRewardsRetry();
  const tierText = useTierText();
  const { summary, treasures, boxes, weekList, week, jobs } = data;
  const error = firstRewardsError(
    summary.error,
    treasures.error,
    boxes.error,
    weekList.error,
    week.error,
    jobs.error,
  );

  if (summary.isPending && summary.fetchStatus !== "idle")
    return (
      <Shell>
        <Loading />
      </Shell>
    );

  const s = summary.data;
  if (s === undefined && error !== null && error.kind !== "rate_limited")
    return (
      <Shell>
        <Unreachable error={error} onRetry={retry} />
      </Shell>
    );

  const busy = error?.kind === "rate_limited";
  // Tuần này: dòng `isLive` của SoDEX; thiếu thì dòng trùng `weekNo` của week/info.
  const current =
    weekList.data?.find((r) => r.isLive === true) ??
    (week.data === undefined
      ? undefined
      : weekList.data?.find((r) => r.weekNo === week.data.weekNo));
  const next =
    week.data === undefined ? null : formatDayTime(secToMs(week.data.distributionTime), tz);
  return (
    <Shell>
      <BotBox
        stale={busy}
        big={
          <>
            <Value text={formatCount(s?.totalPoints)} />
            <span className="text-xs font-semibold text-ink-2">{t("points")}</span>
          </>
        }
        sub={s === undefined ? <Value text={null} /> : <TierRank s={s} tierText={tierText} />}
      />
      {busy ? (
        <Busy onRetry={retry} />
      ) : (
        <>
          <JobLine jobs={jobs.data?.jobs ?? []} />
          <Rows>
            {/* Chỉ hiện số; nút Claim (popup tại chỗ) vào ở #551. */}
            <Row label={t("toClaim")}>
              <Value text={formatCount(treasures.data?.total)} />
            </Row>
            <Row label={t("backpack")}>
              <Value text={formatCount(boxes.data?.total)} />
            </Row>
            <Row label={t("thisWeek")}>
              <Value text={formatCount(current?.points)} />
              {current === undefined ? null : <PointsStatus status={current.pointsStatus} />}
            </Row>
            <Row label={tr("week.next")}>
              <Value text={next} />
            </Row>
          </Rows>
          {error === null ? null : (
            <p role="status" className="m-0 text-xs text-ink-2">
              {error.kind === "business" && error.sodexMessage !== null
                ? `${tr("errors.said")} “${error.sodexMessage}”`
                : tr("errors.network")}
            </p>
          )}
          <Link href="/rewards" className={TONAL}>
            {t("open")}
          </Link>
        </>
      )}
    </Shell>
  );
}
