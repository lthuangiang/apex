// Giờ cho trang Market hours (docs/mockups/market-hours, quy tắc 2–3): múi giờ lấy từ trình duyệt, mốc định nghĩa theo
// UTC và hiện "giờ địa phương · UTC"; "US stock open" = 09:30 America/New_York theo ngày thật. Hàm thuần, dùng Intl
// (đúng cả múi giờ lệch nửa giờ, vd Asia/Kolkata +5:30, và ngày Mỹ đổi giờ).

/** Độ lệch (phút) của múi giờ `tz` so với UTC tại thời điểm `at`. */
export function offsetMinutes(tz: string, at: Date): number {
  if (tz === "UTC") return 0;
  const name =
    new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
  if (m === null) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3] ?? "0"));
}

/** "UTC+7", "UTC+5:30", "UTC−5", "UTC+0". */
export function offsetLabel(minutes: number): string {
  const sign = minutes < 0 ? "−" : "+";
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const mm = abs % 60;
  return `UTC${sign}${String(h)}${mm === 0 ? "" : `:${String(mm).padStart(2, "0")}`}`;
}

/** "07:00" từ số phút trong ngày (cuộn vòng 24 giờ). */
export function hhmm(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Mốc cố định theo UTC (phút trong ngày): 00:00, 02:00, 08:00, 09:00, 16:00 UTC. */
export const UTC_MARKERS = [0, 120, 480, 540, 960] as const;

/** Giờ mở cửa chứng khoán Mỹ trong ngày `at`, theo UTC (phút): 09:30 New York trừ độ lệch của New York hôm đó. */
export function usOpenUtcMinutes(at: Date): number {
  return 9 * 60 + 30 - offsetMinutes("America/New_York", at);
}

export interface Marker {
  /** Cột giờ địa phương (0–23) chứa mốc. */
  hour: number;
  /** Phút trong ngày theo giờ địa phương và theo UTC. */
  local: number;
  utc: number;
  us: boolean;
}

/** Các mốc trong ngày `at` theo độ lệch `offset` (phút) của người xem. */
export function markersFor(offset: number, at: Date): Marker[] {
  const list = [
    ...UTC_MARKERS.map((utc) => ({ utc, us: false })),
    { utc: usOpenUtcMinutes(at), us: true },
  ].sort((a, b) => a.utc - b.utc);
  return list.map(({ utc, us }) => {
    const local = (((utc + offset) % 1440) + 1440) % 1440;
    return { hour: Math.floor(local / 60), local, utc: ((utc % 1440) + 1440) % 1440, us };
  });
}

/** Múi giờ của trình duyệt; không đọc được thì UTC. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
