import type { Db } from "@drift/db";
import { dec, Decimal, SIGNAL_MIN_GROUP, SIGNAL_RANGE_MS, type SignalRange } from "@drift/shared";
import { sql, type SQL } from "drizzle-orm";

import { requireTeam } from "../account/team";

// Phần dùng chung của Signal Analysis (team, #233): kiểm role team, transaction chỉ đọc có statement timeout (như SoDEX
// Debugger, DEC-309), cache ngắn cho các tập dữ liệu nặng, giờ địa phương theo múi giờ của người xem, thống kê.

export interface SignalDeps {
  db: Db;
  now: () => Date;
}

export const FORBIDDEN = "Signal Analysis is for the DeskLabs team only.";

export async function team(deps: SignalDeps, userId: string): Promise<void> {
  await requireTeam(deps.db, userId, FORBIDDEN);
}

/** Truy vấn nặng nhất (fill 30 ngày kèm giá tham chiếu) vẫn phải xong trong chừng này. */
const QUERY_TIMEOUT_MS = 10_000;

export type Exec = Pick<Db, "execute">;

/** Chạy `fn` trong một transaction chỉ đọc có `SET LOCAL statement_timeout` (hợp lệ qua PgBouncer). */
export function readOnly<T>(db: Db, fn: (q: Exec) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${String(QUERY_TIMEOUT_MS)}`));
    await tx.execute(sql`SET LOCAL jit = off`);
    return fn(tx);
  });
}

export const rowsOf = <T>(r: { rows: unknown[] }): T[] => r.rows as T[];

/** Ảnh chụp dữ liệu của một kỳ được giữ chừng này (sets.ts). */
export const DATA_CACHE_MS = 60_000;

export interface Window {
  from: Date;
  to: Date;
}

export function windowOf(range: SignalRange, now: Date): Window {
  return { from: new Date(now.getTime() - SIGNAL_RANGE_MS[range]), to: now };
}

// ── Giờ địa phương ────────────────────────────────────────────────────────────────────────────────────────────────

const HOUR_MS = 3_600_000;

/** Độ lệch (phút) của `tz` so với UTC tại `at`. */
function offsetMinutes(tz: string, at: Date): number {
  if (tz === "UTC") return 0;
  const name =
    new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
  if (m === null) return 0;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? "0"));
}

export interface LocalParts {
  /** YYYY-MM-DD theo giờ địa phương. */
  day: string;
  hour: number;
  /** "YYYY-MM-DDTHH" theo giờ địa phương. */
  hourKey: string;
}

/** Giờ địa phương của mốc epoch ms; độ lệch tính một lần cho mỗi giờ UTC (đúng cả múi giờ lệch nửa giờ). */
export function localClock(tz: string): (ms: number) => LocalParts {
  const offsets = new Map<number, number>();
  return (ms) => {
    const h = Math.floor(ms / HOUR_MS);
    let off = offsets.get(h);
    if (off === undefined) {
      off = offsetMinutes(tz, new Date(h * HOUR_MS));
      offsets.set(h, off);
    }
    const iso = new Date(ms + off * 60_000).toISOString();
    return { day: iso.slice(0, 10), hour: Number(iso.slice(11, 13)), hourKey: iso.slice(0, 13) };
  };
}

// ── Số ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Số làm tròn 2 chữ số; NaN / vô cực → null. */
export const r2 = (v: number | null | undefined): number | null =>
  v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 100) / 100;

export const str = (v: Decimal | null | undefined, dp = 2): string | null =>
  v === null || v === undefined ? null : v.toDecimalPlaces(dp).toFixed();

export function mean(xs: readonly (number | null)[]): number | null {
  let s = 0;
  let n = 0;
  for (const x of xs) {
    if (x === null || !Number.isFinite(x)) continue;
    s += x;
    n += 1;
  }
  return n === 0 ? null : s / n;
}

/** Phân vị nội suy tuyến tính trên các giá trị khác null. */
export function quantileOf(xs: readonly (number | null)[], q: number): number | null {
  const v = xs.filter((x): x is number => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const pos = (v.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = v[lo] ?? 0;
  const b = v[hi] ?? a;
  return a + (b - a) * (pos - lo);
}

/** % mẫu (khác null) có giá trị < 0. */
export function negPct(xs: readonly (number | null)[]): number | null {
  const v = xs.filter((x): x is number => x !== null && Number.isFinite(x));
  return v.length === 0 ? null : (v.filter((x) => x < 0).length / v.length) * 100;
}

export const isThin = (n: number): boolean => n < SIGNAL_MIN_GROUP;

/** bp (theo chiều `dir`): dir × (ref − price) ÷ price × 10 000. */
export function bpOf(dir: 1 | -1, price: string, ref: string | null): number | null {
  if (ref === null) return null;
  const p = Number(price);
  const r = Number(ref);
  if (!(p > 0) || !Number.isFinite(r)) return null;
  return (dir * (r - p) * 10_000) / p;
}

/** $ / 1M: v ÷ volume × 1e6 (Decimal); không có volume → null. */
export function perM(v: Decimal | null, volume: Decimal): Decimal | null {
  return v === null || volume.isZero() ? null : v.div(volume).mul(1_000_000);
}

export const D0 = new Decimal(0);
export { dec, Decimal };

/** "Account ··" + 8 ký tự cuối của user id (DEC-288); không bao giờ email. */
export const tailOf = (userId: string): string => userId.replace(/-/g, "").slice(-8);

export const inList = (xs: readonly string[]): SQL =>
  sql.join(
    xs.map((x) => sql`${x}`),
    sql`, `,
  );

// ── Bot và giá đánh dấu ───────────────────────────────────────────────────────────────────────────────────────────

export interface BotInfo {
  id: string;
  name: string;
  market: string;
  strategy: "volume_maker" | "volume_farm";
  userId: string;
  config: unknown;
}

/** Mọi bot Market Making / Volume Builder tiền thật (kể cả đã dừng / lưu trữ); bảng bots nhỏ. Không bao giờ bot paper. */
export async function liveBots(
  q: Exec,
  strategies: readonly BotInfo["strategy"][],
): Promise<BotInfo[]> {
  const r = await q.execute(sql`
    select b.id::text as id, b.name, b.market, b.strategy, b.user_id::text as "userId", bv.config
      from bots b
      left join bot_versions bv on bv.id = b.active_version_id
      where b.mode = 'live' and b.strategy in (${inList(strategies)})`);
  return rowsOf<BotInfo>(r);
}

/** Giá đóng của nến 1 phút gần nhất tại / trước `at` (trong 1 giờ) của mỗi market; thiếu → không có khoá. */
export async function marksAt(
  q: Exec,
  markets: readonly string[],
  at: Date,
): Promise<Map<string, string>> {
  if (markets.length === 0) return new Map();
  const r = await q.execute(sql`
    select distinct on (market) market, close::text as close
      from candles_1m
      where market in (${inList(markets)}) and ts <= ${at} and ts > ${new Date(at.getTime() - HOUR_MS)}
      order by market, ts desc`);
  return new Map(rowsOf<{ market: string; close: string }>(r).map((x) => [x.market, x.close]));
}

/**
 * Vị thế (base, có dấu) của mỗi bot tại các mốc `ats`: Σ chiều × size của fill trước mốc. Đi theo orders_bot_idx →
 * fills_order_idx, chỉ cho các bot đã có fill trong kỳ (như Platform Stats, DEC-296).
 */
export async function positionsAt(
  q: Exec,
  botIds: readonly string[],
  ats: readonly Date[],
): Promise<Map<string, Decimal>[]> {
  const out = ats.map(() => new Map<string, Decimal>());
  if (botIds.length === 0 || ats.length === 0) return out;
  const cols = sql.join(
    ats.map(
      (at, i) =>
        sql`coalesce(sum(case when o.side = 'buy' then f.size else -f.size end) filter (where f.filled_at < ${at}), 0)::text as ${sql.raw(`p${String(i)}`)}`,
    ),
    sql`, `,
  );
  const last = ats.reduce((a, b) => (a > b ? a : b));
  const r = await q.execute(sql`
    select o.bot_id::text as bot, ${cols}
      from orders o
      join fills f on f.order_id = o.id
      where o.bot_id in (${inList(botIds)}) and o.created_at < ${last}
      group by o.bot_id`);
  for (const row of rowsOf<Record<string, string>>(r)) {
    const bot = row.bot ?? "";
    ats.forEach((_, i) => {
      out[i]?.set(bot, dec(row[`p${String(i)}`] ?? "0"));
    });
  }
  return out;
}

/** Số fill tối đa đọc ngược trước một mốc để tìm lúc vị thế mang sang được mở. */
export const COST_BASIS_LOOKBACK = 2_000;
const COST_BASIS_DAYS = 7;

export interface CostBasis {
  /** Giá vào bình quân (sổ cái giá vốn bình quân) của vị thế đang mở tại mốc. */
  entry: Decimal;
  /** Lúc vị thế đó được mở (đi từ phẳng / đổi chiều). */
  openedAt: number;
}

/**
 * Giá vốn của vị thế `pos` mà bot đang giữ tại `at` (review #246 B2): đọc ngược tối đa 2 000 fill trong 7 ngày trước
 * `at` (orders_bot_idx → fills_order_idx) để tìm fill gần nhất mà trước nó bot phẳng hoặc giữ vị thế ngược chiều, rồi
 * đi xuôi bằng sổ cái giá vốn bình quân (thêm cùng chiều thì bình quân lại, giảm thì giữ giá vào, đổi chiều thì giá vào
 * = giá khớp). Không tìm thấy điểm mở trong giới hạn → null ("Not available"), không đoán.
 */
export async function costBasisAt(
  q: Exec,
  botId: string,
  at: Date,
  pos: Decimal,
): Promise<CostBasis | null> {
  if (pos.isZero()) return null;
  // fills_filled_at_idx đọc ngược từ mốc, lọc theo bot (lệnh không khớp không bị quét).
  const r = await q.execute(sql`
    select (extract(epoch from f.filled_at) * 1000)::float8 as at, o.side, f.price::text as price, f.size::text as size
      from fills f
      join orders o on o.id = f.order_id
      where o.bot_id = ${botId}::uuid
        and f.filled_at < ${at} and f.filled_at >= ${new Date(at.getTime() - COST_BASIS_DAYS * 86_400_000)}
      order by f.filled_at desc, f.id desc
      limit ${COST_BASIS_LOOKBACK}`);
  const rows = rowsOf<{ at: number; side: "buy" | "sell"; price: string; size: string }>(r);
  return costBasisOf(rows, pos);
}

/** Phần thuần của `costBasisAt`: `desc` = fill trước mốc, mới nhất trước. */
export function costBasisOf(
  desc: readonly { at: number; side: "buy" | "sell"; price: string; size: string }[],
  pos: Decimal,
): CostBasis | null {
  let running = pos;
  let start = -1;
  for (let i = 0; i < desc.length; i++) {
    const f = desc[i];
    if (f === undefined) break;
    const signed = dec(f.size).mul(f.side === "buy" ? 1 : -1);
    const before = running.sub(signed);
    if (before.isZero() || before.isNeg() !== pos.isNeg()) {
      start = i;
      break;
    }
    running = before;
  }
  if (start < 0) return null;
  let p = D0;
  let entry: Decimal | null = null;
  let openedAt = 0;
  for (let i = start; i >= 0; i--) {
    const f = desc[i];
    if (f === undefined) continue;
    const s = dec(f.size).mul(f.side === "buy" ? 1 : -1);
    const px = dec(f.price);
    const before = i === start ? running.sub(s) : p;
    const after = before.add(s);
    if (before.isZero() || before.isNeg() !== after.isNeg()) {
      // Mở mới hoặc đổi chiều: giá vào = giá khớp.
      entry = px;
      openedAt = f.at;
    } else if (before.isNeg() === s.isNeg()) {
      entry = (entry ?? px).mul(before.abs()).add(px.mul(s.abs())).div(before.abs().add(s.abs()));
    }
    p = after;
  }
  return entry === null ? null : { entry, openedAt };
}
