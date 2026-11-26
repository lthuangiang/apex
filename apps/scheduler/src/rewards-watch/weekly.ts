import type { RewardsWeekPointsData, RewardsWeekSnapshotData } from "@drift/shared";

// #567: lịch và dữ liệu tin tuần SoDEX rewards (tổng kết tuần sau snapshot, điểm tuần). Logic thuần, không I/O. Lịch
// bám mốc SoDEX trả trong `sopoints/week/list` (`weekEndTime`, `distributionTime`, `status`, `pointsStatus`), không
// hard-code giờ. Mỗi tuần một tin mỗi loại cho mỗi người dùng (mốc `*_week_sent` ở DB + `dedupeKey`).

export const MINUTE = 60_000;
/** Đọc lại khi đang chờ tuần COMPLETED / điểm CONFIRMED. */
export const WEEKLY_POLL_MS = 10 * MINUTE;
/** Bắt đầu kiểm điểm tuần trước `distributionTime`. */
export const POINTS_LEAD_MS = 30 * MINUTE;
/** Quá `distributionTime` ngần này mà chưa CONFIRMED thì thôi, không gửi tin trống. */
export const POINTS_GIVE_UP_MS = 6 * 60 * MINUTE;
/** Quá `weekEndTime` ngần này mà tuần chưa hoàn tất (hoặc người dùng vừa bật) thì bỏ tin tổng kết của tuần đó. */
export const SNAPSHOT_GIVE_UP_MS = 24 * 60 * MINUTE;
/** Không có mốc nào sắp tới thì đọc lại sau ngần này (lịch SoDEX có thể đổi). */
export const WEEKLY_IDLE_MS = 6 * 60 * MINUTE;

type Amount = number | string | null | undefined;

export interface WeekRow {
  weekNo: number;
  weekName: string;
  status?: string | null | undefined;
  isLive?: boolean | null | undefined;
  /** Unix giây. */
  weekStartTime: number;
  weekEndTime: number;
  distributionTime?: number | null | undefined;
  spotVolume?: Amount;
  futuresVolume?: Amount;
  rank?: Amount;
  totalUser?: Amount;
  points?: Amount;
  pointsStatus?: string | null | undefined;
  rankPercentile?: string | null | undefined;
  oi?: Amount;
  accountValue?: Amount;
  vaultHolding?: Amount;
  wealthTvl?: Amount;
  futuresVolumeWeightDetails?:
    { symbol: string; coefficient?: number | string | null | undefined }[] | null | undefined;
}

export interface WeeklyState {
  snapshotSent: number | null;
  pointsSent: number | null;
}

export interface WeeklyPlan {
  /** Tuần cần gửi tin tổng kết ngay (đã COMPLETED). */
  snapshot: WeekRow | null;
  /** Tuần có điểm CONFIRMED, cần gửi tin điểm (người gọi đọc thêm `sopoints/summary`). */
  points: WeekRow | null;
  /** Mốc mới (gồm cả tuần bỏ vì quá hạn: không gửi tin). */
  snapshotSent: number | null;
  pointsSent: number | null;
  /** Lần đọc `week/list` kế tiếp (ms). */
  nextCheckMs: number;
}

const upper = (v: string | null | undefined) => (typeof v === "string" ? v.toUpperCase() : null);

/** Tuần đã hoàn tất: không còn LIVE và `status` COMPLETED (dữ liệu thật 2026-11-26). */
export const isCompletedWeek = (w: WeekRow): boolean =>
  w.isLive !== true && upper(w.status) === "COMPLETED";
export const isPointsConfirmed = (w: WeekRow): boolean => upper(w.pointsStatus) === "CONFIRMED";

/** Lịch tin tuần cho một người dùng tại `nowMs`. Chỉ xét tuần đã kết thúc gần nhất (tuần trước của tuần LIVE). */
export function planWeekly(
  weeks: readonly WeekRow[],
  state: WeeklyState,
  nowMs: number,
): WeeklyPlan {
  const next: number[] = [nowMs + WEEKLY_IDLE_MS];
  let snapshot: WeekRow | null = null;
  let points: WeekRow | null = null;
  let snapshotSent = state.snapshotSent;
  let pointsSent = state.pointsSent;

  const ended = weeks
    .filter((w) => w.weekEndTime * 1000 <= nowMs)
    .sort((a, b) => b.weekNo - a.weekNo);
  const last = ended[0];
  if (last !== undefined) {
    const endMs = last.weekEndTime * 1000;
    if ((snapshotSent ?? -Infinity) < last.weekNo) {
      if (nowMs - endMs > SNAPSHOT_GIVE_UP_MS) snapshotSent = last.weekNo;
      else if (isCompletedWeek(last)) {
        snapshot = last;
        snapshotSent = last.weekNo;
      } else next.push(nowMs + WEEKLY_POLL_MS);
    }
    if ((pointsSent ?? -Infinity) < last.weekNo) {
      const dist = last.distributionTime;
      if (dist == null) {
        // Không có giờ chia điểm thì không có cửa sổ để chờ: chờ như tin tổng kết, rồi bỏ.
        if (nowMs - endMs > SNAPSHOT_GIVE_UP_MS) pointsSent = last.weekNo;
        else next.push(nowMs + WEEKLY_POLL_MS);
      } else {
        const distMs = dist * 1000;
        if (nowMs < distMs - POINTS_LEAD_MS) next.push(distMs - POINTS_LEAD_MS);
        else if (nowMs > distMs + POINTS_GIVE_UP_MS) pointsSent = last.weekNo;
        else if (isPointsConfirmed(last)) {
          points = last;
          pointsSent = last.weekNo;
        } else next.push(nowMs + WEEKLY_POLL_MS);
      }
    }
  }
  // Tuần đang chạy: đọc lại khi nó kết thúc (lúc đó mới có tin tổng kết).
  const upcoming = weeks
    .filter((w) => w.weekEndTime * 1000 > nowMs)
    .map((w) => w.weekEndTime * 1000);
  if (upcoming.length > 0) next.push(Math.min(...upcoming));

  return {
    snapshot,
    points,
    snapshotSent,
    pointsSent,
    nextCheckMs: Math.max(nowMs + MINUTE, Math.min(...next)),
  };
}

/** Số / chuỗi số SoDEX trả → chuỗi (giữ nguyên, không tính bằng float); thiếu → null. */
export function amountText(v: Amount): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** Cặp có hệ số nhân cao nhất (> 1); bằng nhau thì theo thứ tự API. */
export function boostedOf(w: WeekRow): RewardsWeekSnapshotData["boosted"] {
  const list = (w.futuresVolumeWeightDetails ?? [])
    .map((d) => ({ symbol: d.symbol, coefficient: amountText(d.coefficient) }))
    .filter(
      (d): d is { symbol: string; coefficient: string } =>
        d.coefficient !== null && Number(d.coefficient) > 1,
    );
  const unique = [...new Map(list.map((d) => [d.symbol, d])).values()];
  if (unique.length === 0) return null;
  let top = unique[0];
  for (const d of unique)
    if (top === undefined || Number(d.coefficient) > Number(top.coefficient)) top = d;
  if (top === undefined) return null;
  return { symbol: top.symbol, coefficient: top.coefficient, more: unique.length - 1 };
}

export function snapshotData(w: WeekRow, timeZone: string): RewardsWeekSnapshotData {
  return {
    weekNo: w.weekNo,
    weekName: w.weekName,
    weekStartTime: w.weekStartTime,
    weekEndTime: w.weekEndTime,
    futuresVolume: amountText(w.futuresVolume),
    spotVolume: amountText(w.spotVolume),
    oi: amountText(w.oi),
    accountValue: amountText(w.accountValue),
    vaultHolding: amountText(w.vaultHolding),
    wealthTvl: amountText(w.wealthTvl),
    boosted: boostedOf(w),
    distributionTime: w.distributionTime ?? null,
    timeZone,
  };
}

export interface SummaryForPoints {
  totalPoints: Amount;
  currentTier?: Amount;
  nextTier?: Amount;
  nextTierPoints?: Amount;
}

export function pointsData(
  w: WeekRow,
  summary: SummaryForPoints | null,
  timeZone: string,
): RewardsWeekPointsData {
  return {
    weekNo: w.weekNo,
    weekName: w.weekName,
    points: amountText(w.points),
    rank: amountText(w.rank),
    totalUser: amountText(w.totalUser),
    rankPercentile: w.rankPercentile ?? null,
    totalPoints: summary === null ? null : amountText(summary.totalPoints),
    currentTier: summary === null ? null : amountText(summary.currentTier),
    nextTier: summary === null ? null : amountText(summary.nextTier),
    nextTierPoints: summary === null ? null : amountText(summary.nextTierPoints),
    timeZone,
  };
}
