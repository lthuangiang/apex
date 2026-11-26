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

/** Khối lượng: "$84,300" ([confirm] đơn vị; bản phác đã duyệt hiện USD). */
export function formatVolume(value: NumLike | null | undefined): string | null {
  const text = formatCount(value);
  return text === null ? null : `$${text}`;
}

/** Giá trị USD của phần thưởng (`rewardUsd`): "$110.89". */
export function formatUsd(value: string | null | undefined): string | null {
  const d = decimalOf(value);
  if (d === null) return null;
  const text = formatDecimal(d, {
    locale: LOCALE,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return text === null ? null : `$${text}`;
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
      return "bg-muted";
    case "uncommon":
      return "bg-pos-dot";
    case "rare":
      return "bg-accent";
    case "superrare":
      return "bg-unknown";
    default:
      return "bg-border-input";
  }
}
