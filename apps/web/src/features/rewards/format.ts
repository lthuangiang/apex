import { DECIMAL_STRING_PATTERN, dec, formatDecimal } from "@drift/shared";

// Định dạng số / giờ của SoDEX rewards (#548). Chỉ định dạng giá trị SoDEX trả về; giá trị thiếu hay lạ thì trả null để
// UI hiện "Not available" (quy tắc 8), không bao giờ thành 0. Nhiều trường còn [confirm] kiểu (số hay chuỗi, README bản
// phác mục câu hỏi 4) nên nhận cả hai.

const LOCALE = "en-US";

export type NumLike = number | string;

/** Số hoặc chuỗi số của SoDEX → chuỗi thập phân; null khi thiếu hoặc không phải số. */
export function decimalOf(value: NumLike | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const s = String(value);
    return DECIMAL_STRING_PATTERN.test(s) ? s : null;
  }
  const s = value.trim();
  return DECIMAL_STRING_PATTERN.test(s) ? s : null;
}

/** Điểm / hạng / số đếm: "48,210" (tối đa 2 chữ số thập phân nếu SoDEX trả số lẻ). */
export function formatCount(value: NumLike | null | undefined): string | null {
  const d = decimalOf(value);
  return d === null ? null : formatDecimal(d, { locale: LOCALE, maximumFractionDigits: 2 });
}

/**
 * Một cách hiện USD cho mọi chỗ trong Rewards (khối lượng tuần, giá trị phần thưởng, tổng kết, history): luôn 2 chữ số
 * thập phân, kể cả số nguyên và 0 ("$84,300.00", "$0.00"), khớp trang SoDEX và bản phác (PM review #574).
 */
export function formatUsdAmount(value: NumLike | null | undefined): string | null {
  const d = decimalOf(value);
  if (d === null) return null;
  const text = formatDecimal(d, {
    locale: LOCALE,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return text === null ? null : `$${text}`;
}

/** Khối lượng tuần (USD, dữ liệu thật). */
export function formatVolume(value: NumLike | null | undefined): string | null {
  return formatUsdAmount(value);
}

/** Giá trị USD của phần thưởng (`rewardUsd`). */
export function formatUsd(value: string | null | undefined): string | null {
  return formatUsdAmount(value);
}

export type WeekState = "confirmed" | "live" | "snapshot" | "unknown";

/**
 * Trạng thái điểm của một tuần (đối chiếu trang SoPoints của SoDEX, PM 2026-11-26): `isLive` → đang chạy ("In progress");
 * đã kết thúc mà `pointsStatus` khác CONFIRMED → đã chụp, chưa chốt ("Snapshot done"); CONFIRMED → điểm đã chốt (kể cả 0
 * thật). Tới khi biết giá trị thật, mọi `pointsStatus` khác CONFIRMED đều coi là chưa chốt. Không có `pointsStatus` và
 * không live → "unknown" (hiện số SoDEX trả nếu có).
 */
export function weekState(row: {
  isLive?: boolean | null | undefined;
  pointsStatus?: string | null | undefined;
}): WeekState {
  if (row.isLive === true) return "live";
  const st = row.pointsStatus;
  if (st == null || st === "") return "unknown";
  return st.toUpperCase() === "CONFIRMED" ? "confirmed" : "snapshot";
}

/** Điểm hiện được của một tuần: tuần chưa chốt (live / snapshot) không có số (quy tắc 8). */
export function weekPoints(row: {
  points?: NumLike | null | undefined;
  isLive?: boolean | null | undefined;
  pointsStatus?: string | null | undefined;
}): { state: WeekState; text: string | null; hide: boolean } {
  const state = weekState(row);
  if (state === "live" || state === "snapshot") return { state, text: null, hide: true };
  return { state, text: formatCount(row.points), hide: false };
}

/** Hạng: 0 hoặc thiếu là chưa có hạng → null (bảng tuần hiện "–" mờ). */
export function formatRank(value: NumLike | null | undefined): string | null {
  const d = decimalOf(value);
  return d === null || dec(d).isZero() ? null : formatCount(d);
}

/** Giá trị lạ chưa có nhãn duyệt: hiện nguyên chuỗi SoDEX trả, viết hoa chữ đầu ("manual" → "Manual"). */
export function capitalizeRaw(v: string): string {
  return v.length === 0 ? v : v.charAt(0).toUpperCase() + v.slice(1);
}

/** Số lượng token phần thưởng: giữ tối đa 4 chữ số thập phân như bản phác ("0.9945 vANT"). */
export function formatTokenAmount(value: string | null | undefined): string | null {
  const d = decimalOf(value);
  return d === null ? null : formatDecimal(d, { locale: LOCALE, maximumFractionDigits: 4 });
}

/** Tổng theo tài sản (`history.totalRewardByAsset`): giữ tối đa 8 chữ số thập phân. */
export function formatAssetTotal(value: string | null | undefined): string | null {
  const d = decimalOf(value);
  return d === null ? null : formatDecimal(d, { locale: LOCALE, maximumFractionDigits: 8 });
}

/** Hệ số nhân khối lượng: "1.20" → "×1.2". */
export function formatCoefficient(value: string): string | null {
  const d = decimalOf(value);
  if (d === null) return null;
  const text = formatDecimal(d, { locale: LOCALE, maximumFractionDigits: 4 });
  return text === null ? null : `×${text}`;
}

/**
 * Cặp có hệ số nhân, hệ số cao nhất trước; bằng nhau giữ thứ tự SoDEX trả (sort ổn định; quyết định PM, README bản phác
 * mục 7). Hệ số không đọc được xếp cuối.
 */
export function sortByCoefficient<T extends { coefficient: string }>(weights: readonly T[]): T[] {
  return weights
    .map((w, i) => ({ w, i, d: decimalOf(w.coefficient) }))
    .sort((a, b) => {
      if (a.d === null || b.d === null) return a.d === null ? (b.d === null ? a.i - b.i : 1) : -1;
      const c = dec(b.d).comparedTo(dec(a.d));
      return c === 0 ? a.i - b.i : c;
    })
    .map((x) => x.w);
}

function parts(ms: number, timeZone: string, opts: Intl.DateTimeFormatOptions): string | null {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(LOCALE, { ...opts, timeZone }).format(d);
  } catch {
    return new Intl.DateTimeFormat(LOCALE, { ...opts, timeZone: "UTC" }).format(d);
  }
}

/** "Dec 4, 19:00" theo múi giờ của trình duyệt. */
export function formatDayTime(ms: number, timeZone: string): string | null {
  return parts(ms, timeZone, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

/** "Nov 24". */
export function formatDay(ms: number, timeZone: string): string | null {
  return parts(ms, timeZone, { month: "short", day: "numeric" });
}

/** Unix giây của SoDEX (`week/info`, `week/list`) → ms. */
export const secToMs = (sec: number): number => sec * 1000;

/** Múi giờ IANA của trình duyệt; lỗi thì UTC. */
export function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * Màu chấm của cấp box. SoDEX trả tên cấp dạng chuỗi ([confirm] danh sách); chữ hiện nguyên tên SoDEX trả, màu chỉ là
 * phụ (trạng thái không bao giờ chỉ bằng màu).
 */
export function levelDotClass(level: string): string {
  switch (level.toLowerCase().replace(/[\s_-]/g, "")) {
    case "common":
      return "bg-lvl-common";
    case "uncommon":
      return "bg-lvl-uncommon";
    case "rare":
      return "bg-lvl-rare";
    case "superrare":
      return "bg-lvl-superrare";
    default:
      return "bg-border-input";
  }
}

/** `mintedAt` (ISO trong dữ liệu thật; số thì giây hoặc ms) → ms; đọc không được thì null. */
export function mintedMs(v: NumLike | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  const n = Number(v);
  if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * "Reward range · set by SoDEX" của một cấp (#575, DEC-400) từ `rules.rewardBands`: "$1.00 – $8.00". Không có band cho cấp
 * đó, hoặc band thiếu / lệch số → null (không hiện dòng). Không bao giờ hiện xác suất.
 */
export function rewardRange(
  bands:
    | readonly {
        level: string;
        minUsd?: NumLike | null | undefined;
        maxUsd?: NumLike | null | undefined;
      }[]
    | null
    | undefined,
  level: string | null | undefined,
): string | null {
  if (level == null || bands == null) return null;
  const key = level.toLowerCase();
  const b = bands.find((x) => x.level.toLowerCase() === key);
  if (b === undefined) return null;
  const min = formatUsdAmount(b.minUsd);
  const max = formatUsdAmount(b.maxUsd);
  return min === null || max === null ? null : `${min} – ${max}`;
}

/** Cấp có trong `rules.tradeBoxLevels` → nhãn "From trading". */
export function fromTrading(
  levels: readonly string[] | null | undefined,
  level: string | null | undefined,
): boolean {
  return level != null && (levels ?? []).some((l) => l.toLowerCase() === level.toLowerCase());
}
