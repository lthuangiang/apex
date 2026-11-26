import {
  escapeTelegramHtml,
  rewardsWeekPointsDataSchema,
  rewardsWeekSnapshotDataSchema,
  type RewardsWeekPointsData,
  type RewardsWeekSnapshotData,
} from "@drift/shared";

import messages from "./messages/en.json" with { type: "json" };

// Tin tuần SoDEX rewards trên Telegram (#567, mẫu chủ sản phẩm duyệt 2026-11-26). Quy tắc 8: trường null / thiếu thì bỏ
// dòng, không ghi 0; giá trị 0 thật thì hiện "$0.00". Không có địa chỉ ví, không có trường squad (`team*`,
// `totalBonusPct`). Giờ theo múi giờ hồ sơ người dùng (`data.timeZone`). Chuỗi từ SoDEX được escape.

const M = messages.telegram.rewardsWeek;

function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));
}

const num = (v: string | null): number | null => {
  if (v === null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** "$70,722.87" (chỉ để hiển thị; không cộng trừ). */
export function usd(v: string | null): string | null {
  const n = num(v);
  if (n === null) return null;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "29,556" (số nguyên có dấu phẩy). */
export function count(v: string | null): string | null {
  const n = num(v);
  return n === null ? null : n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

/** Thứ hạng / tổng người: SoDEX trả 0 khi chưa xếp hạng (dữ liệu thật 2026-11-26), nên 0 hoặc âm coi như thiếu. */
function ranked(v: string | null): string | null {
  const n = num(v);
  return n === null || n <= 0 ? null : count(v);
}

function safeZone(tz: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

function dayMonth(s: number, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: tz }).format(
    new Date(s * 1000),
  );
}

/** "Fri, Dec 4 · 19:00" theo múi giờ người nhận. */
export function weekdayTime(s: number, tz: string): string {
  const d = new Date(s * 1000);
  const day = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: tz,
  }).format(d);
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: tz,
  }).format(d);
  return `${day} · ${time}`;
}

/**
 * Các dòng nhãn / giá trị trong khối `<pre>` (như mẫu): `right` căn số sang phải (tổng kết tuần), `left` để giá trị ngay
 * sau cột nhãn (điểm tuần). Dòng thiếu giá trị bị bỏ.
 */
function table(rows: readonly [string, string | null][], align: "right" | "left"): string | null {
  const kept = rows.filter((r): r is [string, string] => r[1] !== null);
  if (kept.length === 0) return null;
  const keyWidth = Math.max(...kept.map(([k]) => k.length)) + 3;
  const width = Math.max(...kept.map(([k, v]) => k.length + v.length)) + 4;
  const lines = kept.map(([k, v]) =>
    align === "right"
      ? `${k}${" ".repeat(width - k.length - v.length)}${v}`
      : `${k.padEnd(keyWidth)}${v}`,
  );
  return `<pre>${escapeTelegramHtml(lines.join("\n"))}</pre>`;
}

const weekLabel = (d: { weekNo: number; weekName: string | null }) =>
  escapeTelegramHtml(d.weekName ?? fill(M.weekFallback, { n: d.weekNo }));

export function weekSnapshotMessage(data: RewardsWeekSnapshotData): {
  title: string;
  body: string | null;
} {
  const tz = safeZone(data.timeZone);
  const title = fill(M.snapshotTitle, { week: weekLabel(data) });
  const parts: string[] = [];
  if (data.weekStartTime !== null && data.weekEndTime !== null)
    parts.push(
      fill(M.range, { from: dayMonth(data.weekStartTime, tz), to: dayMonth(data.weekEndTime, tz) }),
    );
  const t = table(
    [
      [M.perps, usd(data.futuresVolume)],
      [M.spot, usd(data.spotVolume)],
      [M.oi, usd(data.oi)],
      [M.accountValue, usd(data.accountValue)],
      [M.vault, usd(data.vaultHolding)],
      [M.wealthTvl, usd(data.wealthTvl)],
    ],
    "right",
  );
  if (t !== null) parts.push(t);
  const tail: string[] = [];
  if (data.boosted !== null) {
    const coef = escapeTelegramHtml(data.boosted.coefficient);
    const symbol = escapeTelegramHtml(data.boosted.symbol);
    tail.push(
      data.boosted.more > 0
        ? fill(M.boostedMore, { symbol, coef, n: data.boosted.more })
        : fill(M.boosted, { symbol, coef }),
    );
  }
  if (data.distributionTime !== null)
    tail.push(fill(M.pointsArrive, { when: weekdayTime(data.distributionTime, tz) }));
  if (tail.length > 0) parts.push(tail.join("\n"));
  return { title, body: parts.length === 0 ? null : parts.join("\n\n") };
}

export function weekPointsMessage(data: RewardsWeekPointsData): {
  title: string;
  body: string | null;
} {
  const pts = count(data.points);
  const title =
    pts === null
      ? fill(M.pointsTitleNoNumber, { week: weekLabel(data) })
      : fill(M.pointsTitle, { week: weekLabel(data), points: pts });
  const rank = ranked(data.rank);
  const total = ranked(data.totalUser);
  const rankParts: string[] = [];
  if (rank !== null)
    rankParts.push(total === null ? fill(M.rank, { rank }) : fill(M.rankOf, { rank, total }));
  if (data.rankPercentile !== null) rankParts.push(escapeTelegramHtml(data.rankPercentile));
  const totalPoints = num(data.totalPoints);
  const nextAt = num(data.nextTierPoints);
  let next: string | null = null;
  if (data.nextTier !== null && nextAt !== null) {
    const tier = data.nextTier;
    const at = count(data.nextTierPoints) ?? "";
    // Còn thiếu = nextTierPoints − totalPoints; ngưỡng ≤ tổng hoặc thiếu tổng thì bỏ phần "to go".
    next =
      totalPoints !== null && nextAt > totalPoints
        ? fill(M.nextToGo, {
            tier,
            at,
            left: (nextAt - totalPoints).toLocaleString("en-US", { maximumFractionDigits: 0 }),
          })
        : fill(M.next, { tier, at });
  }
  const totalText = count(data.totalPoints);
  const t = table(
    [
      [M.total, totalText === null ? null : fill(M.totalValue, { points: totalText })],
      [M.tier, data.currentTier],
      [M.nextLabel, next],
    ],
    "left",
  );
  const parts = [rankParts.length === 0 ? null : rankParts.join(" · "), t].filter(
    (p): p is string => p !== null,
  );
  return { title, body: parts.length === 0 ? null : parts.join("\n\n") };
}

/** Tin tuần từ `notifications.payload`; dữ liệu sai dạng thì null (người gọi dùng câu chung). */
export function rewardsWeekMessage(
  type: "rewards_week_snapshot" | "rewards_week_points",
  data: Record<string, unknown>,
): { title: string; body: string | null } | null {
  if (type === "rewards_week_snapshot") {
    const d = rewardsWeekSnapshotDataSchema.safeParse(data);
    return d.success ? weekSnapshotMessage(d.data) : null;
  }
  const d = rewardsWeekPointsDataSchema.safeParse(data);
  return d.success ? weekPointsMessage(d.data) : null;
}
