import type { ResearchDropReason, ResearchFunnel, ResearchStage } from "../api/signal-research";
import { dec, Decimal, type DecimalInput } from "../money";

import { closeResult } from "./logic";
import type { TradeDirection } from "./rules";

// Hàm thuần cho phần hiển thị của Signal research (#297): đếm phễu, làm tròn giá theo tick, tên tag SoSoValue, số dư bot
// giấy. Không I/O. Dùng chung cho db (tổng kết), api và web để mọi nơi ra cùng một con số.

// ── Số dư bot giấy ────────────────────────────────────────────────────────────────────────────────────────────────

/** Vốn giả ban đầu của mỗi bot giấy (USDC), như câu "each with its own 10,000 USDC of fake money". */
export const RESEARCH_BOT_START_USDC = "10000";

/**
 * Số dư bot giấy = vốn đầu (10 000 USDC) + tổng kết quả sau phí (`result_usdc`) của các lệnh ĐÃ ĐÓNG. Lệnh đang mở không
 * tính vào đây (xem `unrealizedUsdc`). Không có lệnh đóng nào thì số dư đúng bằng vốn đầu (số thật, không phải thiếu dữ
 * liệu).
 */
export function paperBalance(closedResults: readonly DecimalInput[]): Decimal {
  return closedResults.reduce<Decimal>((s, r) => s.add(dec(r)), dec(RESEARCH_BOT_START_USDC));
}

export interface OpenPaperTrade {
  direction: TradeDirection;
  entryPrice: DecimalInput;
  qty: DecimalInput;
  sizeUsdc: DecimalInput;
  entryFee: DecimalInput;
  feePct: DecimalInput;
}

/**
 * Lãi / lỗ chưa chốt của một lệnh đang mở = kết quả nếu đóng NGAY ở giá thoát `exitPrice` (cùng công thức `closeResult`
 * khi lệnh đóng thật: lãi giá − phí vào − phí ra tính trên notional lúc ra). Giá thoát là bid cho Long, ask cho Short, còn
 * mới (`exitPriceOf`, #308). Không có giá → null.
 */
export function unrealizedUsdc(t: OpenPaperTrade, exitPrice: DecimalInput | null): Decimal | null {
  if (exitPrice === null) return null;
  const px = dec(exitPrice);
  if (px.lte(0)) return null;
  return closeResult({
    direction: t.direction,
    entryPrice: t.entryPrice,
    exitPrice: px,
    qty: t.qty,
    sizeUsdc: t.sizeUsdc,
    entryFee: t.entryFee,
    feePct: t.feePct,
  }).resultUsdc;
}

// ── Giá theo tick ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Làm tròn giá tới bội số gần nhất của tick size của market (nửa tick làm tròn lên, ROUND_HALF_UP). Tick không biết /
 * không hợp lệ → trả nguyên giá. Kết quả giữ đúng số chữ số thập phân của tick ("61412.99" với tick 0.01).
 */
export function roundToTick(price: DecimalInput, tick: DecimalInput | null | undefined): Decimal {
  const p = dec(price);
  if (tick === null || tick === undefined) return p;
  let t: Decimal;
  try {
    t = dec(tick);
  } catch {
    return p;
  }
  if (!t.isFinite() || t.lte(0)) return p;
  return p.toNearest(t, Decimal.ROUND_HALF_UP).toDecimalPlaces(t.decimalPlaces());
}

// ── Tên tag SoSoValue ─────────────────────────────────────────────────────────────────────────────────────────────

const pickName = (o: Record<string, unknown>): string | null => {
  for (const [k, v] of Object.entries(o))
    if (k.toUpperCase() === "EN" && typeof v === "string" && v.trim() !== "") return v.trim();
  for (const v of Object.values(o)) if (typeof v === "string" && v.trim() !== "") return v.trim();
  return null;
};

/**
 * Tên một coin / cổ phiếu SoSoValue gắn cho bài. SoSoValue ghi tên cổ phiếu dạng JSON (`{"EN": "NVIDIA CORPORATION"}`,
 * có khi là chuỗi chứa JSON, có khi là object): đọc `EN`, không có thì chuỗi đầu tiên. Không bao giờ trả JSON thô.
 */
export function tagName(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "object" && !Array.isArray(raw))
    return pickName(raw as Record<string, unknown>);
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (s === "") return null;
  if (s.startsWith("{")) {
    try {
      const v: unknown = JSON.parse(s);
      if (v !== null && typeof v === "object" && !Array.isArray(v))
        return pickName(v as Record<string, unknown>);
    } catch {
      // Không phải JSON hợp lệ: giữ chuỗi nhưng không để lộ dấu ngoặc của JSON hỏng.
    }
    return null;
  }
  return s;
}

// ── Phễu ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export type ArticleStop = ResearchFunnel["articleStops"][number];

export interface FunnelStep {
  stage: ResearchStage;
  /** Số bài vào bước này (= `passed` của bước trước; Collect: mọi bài thu trong khoảng). */
  in: number;
  /** Bị loại ở bước này. */
  dropped: number;
  /** Gộp vào câu chuyện đã có (chỉ Filter); không phải bị loại nhưng không đi tiếp. */
  merged: number;
  /** Đã vào bước này nhưng chưa xử lý xong (chờ Normalize / Claude…). */
  waiting: number;
  /** Đi tiếp sang bước sau: `in − dropped − merged − waiting`. Decide: số bài đã mở lệnh giấy. */
  passed: number;
  /** Lý do bị loại ở bước này (số bài), nhiều nhất trước. */
  reasons: { reason: ResearchDropReason; n: number }[];
}

const STAGE_ORDER: readonly ResearchStage[] = ["collect", "normalize", "score", "filter", "decide"];

/**
 * Năm bước của phễu, đếm cùng MỘT đơn vị (bài thu trong khoảng thời gian) từ `articleStops`, nên `in − dropped − merged −
 * waiting = passed = in` của bước sau.
 *
 * - Collect thu mọi bài: không bài nào bị loại ở Collect. Bài "dừng ở Collect" vì SoSoValue không gắn coin
 *   (`noTaggedCurrency`) thực ra bị bước Normalize loại (event `NO_SODEX_MARKET`), nên được trừ ở Normalize; bài còn chờ
 *   ở Collect là bài chờ Normalize.
 * - Bài `waiting` có `stage` = bước cuối đã qua, nên được tính là "đang chờ" ở bước KẾ TIẾP.
 * - Bài `traded` qua hết; Decide.passed = số bài đã mở lệnh.
 */
export function funnelSteps(stops: readonly ArticleStop[]): FunnelStep[] {
  const idx = (s: ResearchStage) => STAGE_ORDER.indexOf(s);
  const dropped = [0, 0, 0, 0, 0];
  const merged = [0, 0, 0, 0, 0];
  const waiting = [0, 0, 0, 0, 0];
  const reasons = STAGE_ORDER.map(() => new Map<ResearchDropReason, number>());
  let total = 0;
  for (const s of stops) {
    if (s.n <= 0) continue;
    total += s.n;
    const k = idx(s.stage);
    if (k < 0) continue;
    if (s.outcome === "dropped") {
      const at = Math.max(1, k);
      dropped[at] = (dropped[at] ?? 0) + s.n;
      if (s.reason !== null) {
        const m = reasons[at];
        m?.set(s.reason, (m.get(s.reason) ?? 0) + s.n);
      }
    } else if (s.outcome === "merged") {
      const at = Math.max(1, k);
      merged[at] = (merged[at] ?? 0) + s.n;
    } else if (s.outcome === "waiting") {
      const at = Math.min(k + 1, STAGE_ORDER.length - 1);
      waiting[at] = (waiting[at] ?? 0) + s.n;
    }
  }
  const out: FunnelStep[] = [];
  let into = total;
  STAGE_ORDER.forEach((stage, i) => {
    const d = dropped[i] ?? 0;
    const m = merged[i] ?? 0;
    const w = waiting[i] ?? 0;
    const passed = into - d - m - w;
    out.push({
      stage,
      in: into,
      dropped: d,
      merged: m,
      waiting: w,
      passed,
      reasons: [...(reasons[i] ?? new Map<ResearchDropReason, number>())]
        .map(([reason, n]) => ({ reason, n }))
        .sort((a, b) => b.n - a.n || (a.reason < b.reason ? -1 : 1)),
    });
    into = passed;
  });
  return out;
}
