// Lịch Recurring Buy theo múi giờ IANA của người dùng (CODING_STANDARDS mục 12: dùng múi giờ người dùng).
// Hàm thuần: tính lần chạy kế tiếp sau `after` (ms UTC).

export interface BuySchedule {
  frequency: "daily" | "weekly" | "monthly";
  /** 0 = Chủ nhật … 6 = Thứ bảy (weekly). */
  dayOfWeek?: number | undefined;
  /** 1–28 (monthly). */
  dayOfMonth?: number | undefined;
  /** "HH:MM" giờ địa phương. */
  time: string;
  timeZone: string;
}

/** Độ lệch (ms) của múi giờ tại thời điểm `utcMs`: giờ địa phương − UTC. */
export function tzOffsetMs(timeZone: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Giờ địa phương (y, m, d, h, min) → ms UTC. */
function localToUtc(
  timeZone: string,
  y: number,
  m: number,
  d: number,
  h: number,
  min: number,
): number {
  const guess = Date.UTC(y, m, d, h, min);
  const offset = tzOffsetMs(timeZone, guess - tzOffsetMs(timeZone, guess));
  return guess - offset;
}

export function nextRun(s: BuySchedule, after: number): number {
  const [hh = 0, mm = 0] = s.time.split(":").map(Number);
  const local = new Date(after + tzOffsetMs(s.timeZone, after));
  for (let addDays = 0; addDays <= 62; addDays += 1) {
    const day = new Date(
      Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + addDays),
    );
    const ok =
      s.frequency === "daily" ||
      (s.frequency === "weekly" && day.getUTCDay() === (s.dayOfWeek ?? 1)) ||
      (s.frequency === "monthly" && day.getUTCDate() === (s.dayOfMonth ?? 1));
    if (!ok) continue;
    const at = localToUtc(
      s.timeZone,
      day.getUTCFullYear(),
      day.getUTCMonth(),
      day.getUTCDate(),
      hh,
      mm,
    );
    if (at > after) return at;
  }
  throw new RangeError("No schedule within 62 days");
}
