import { Decimal, dec } from "../money";

import { liquidationDistance, type MarginTier, type NeedsYouRule } from "./needs-you";

// AI Desk B+ M2 (DEC-166): phương án sửa cho mỗi việc "Needs you" và lựa chọn của Desk AI. Hàm thuần: worker replay /
// backtest từng phương án, hàm ở đây sinh phương án (patch config) và chọn "My pick" từ kết quả. Không dự báo: kết quả
// là 7 ngày đã qua ("not a forecast").

export const WHATIF_CONFIG = {
  /** Cửa sổ so sánh (DEC-166: "Last 7 days"). */
  windowMs: 7 * 86_400_000,
  /** Stop phải chạm trước khi giá đi được chừng này phần đường tới thanh lý ước tính (biên an toàn của phương án). */
  stopToLiquidation: "0.8",
  /** Ít lượt hơn chừng này trong cửa sổ → "Not enough trades to compare" (không hiện 0). */
  minTrades: 5,
  /** Chênh nhỏ hơn mức này (USDC) coi như không khác (như "No clear effect" của DEC-166). */
  noClearEffectUsd: "0.5",
  /**
   * Job còn `queued` lâu hơn mức này coi như tin trong hàng đợi đã mất (ví dụ worker bản cũ nhận rồi bỏ lúc deploy):
   * không dùng lại, đánh `failed` (`stale`) và xếp job mới.
   */
  queuedReuseMs: 2 * 60_000,
  /** Scheduler đánh `failed` (`stale`) job còn `queued` quá mức này. */
  staleQueuedMs: 10 * 60_000,
  /** Job `failed` còn hiện trên trang chủ chừng này rồi mới xếp lại (không xếp lại mỗi lần tải trang). */
  failedRetryMs: 10 * 60_000,
} as const;

export const WHATIF_OPTION_KEYS = [
  "keep",
  "lower_leverage",
  "tighter_stop",
  "review_settings",
] as const;
export type WhatIfOptionKey = (typeof WHATIF_OPTION_KEYS)[number];

/** Giá trị mới của field config; null = xoá field (config cũ). */
export type ConfigPatch = Record<string, string | number | null>;

export interface WhatIfOption {
  key: WhatIfOptionKey;
  patch: ConfigPatch;
}

export interface WhatIfOutcome {
  trades: number;
  /** Lãi / lỗ ròng 7 ngày (USDC). */
  net: string;
  /** Lượt đóng bởi stop loss gốc trên SoDEX; null khi nguồn không đếm được. Không gồm thanh lý (chưa mô phỏng). */
  closedBySodex: number | null;
  /** Lượt tệ nhất (USDC); null khi nguồn không tách được lượt. */
  worstTrade: string | null;
  /** Ký quỹ mỗi lệnh (USDC); null khi không tính được. */
  marginPerTrade: string | null;
}

export interface WhatIfOptionResult extends WhatIfOption {
  /** null + `unavailable` khi phương án không chạy được (config không hợp lệ, thiếu dữ liệu). */
  outcome: WhatIfOutcome | null;
  unavailable: "invalid_config" | "not_enough_trades" | "no_data" | null;
}

/** Đầu vào cho phương án quy tắc 1 (đòn bẩy / stop hiện tại của bot). */
export interface RiskInput {
  strategy: string;
  leverage: number;
  /** Khoảng stop hiện tại theo tỷ lệ giá. */
  stopDistance: string;
  side: "long" | "short" | "both";
  notional: string;
  tiers: readonly MarginTier[];
  /** Field stop của chiến lược và cách quy đổi (Volume Farm theo % margin ⇒ phụ thuộc đòn bẩy). */
  stopField: "slMarginPct" | "slPct" | "stopLossPct" | "hardStopLossPct" | null;
  /** `slMarginPct` hiện tại (Volume Farm); null với chiến lược khác. */
  slMarginPct: string | null;
}

function liqAt(r: RiskInput, leverage: number): Decimal | null {
  const sides: ("long" | "short")[] = r.side === "both" ? ["long", "short"] : [r.side];
  let min: Decimal | null = null;
  for (const side of sides) {
    const d = liquidationDistance({ tiers: r.tiers, leverage, notional: r.notional, side });
    if (d !== null && (min === null || d.lt(min))) min = d;
  }
  return min;
}

/** Khoảng stop khi đổi đòn bẩy: Volume Farm theo % margin thì khoảng giá = % margin ÷ đòn bẩy; còn lại giữ nguyên. */
function stopAt(r: RiskInput, leverage: number): Decimal {
  if (r.stopField === "slMarginPct" && r.slMarginPct !== null)
    return dec(r.slMarginPct).div(100).div(leverage);
  return dec(r.stopDistance);
}

const safe = (stop: Decimal, liq: Decimal): boolean =>
  stop.lte(liq.mul(WHATIF_CONFIG.stopToLiquidation));

/** Quy tắc 1: hạ đòn bẩy xuống mức cao nhất mà stop chạm trước thanh lý (có biên). Không có mức nào → null. */
export function lowerLeverageOption(r: RiskInput): WhatIfOption | null {
  for (let l = r.leverage - 1; l >= 1; l -= 1) {
    const liq = liqAt(r, l);
    if (liq !== null && safe(stopAt(r, l), liq))
      return { key: "lower_leverage", patch: { leverage: l } };
  }
  return null;
}

/** Quy tắc 1: giữ đòn bẩy, siết stop vào trong biên an toàn (làm tròn xuống 0.1). Quá chặt (< 0.1) → null. */
export function tighterStopOption(r: RiskInput): WhatIfOption | null {
  if (r.stopField === null) return null;
  const liq = liqAt(r, r.leverage);
  if (liq === null) return null;
  const maxStop = liq.mul(WHATIF_CONFIG.stopToLiquidation);
  // Volume Farm `slMarginPct`: % margin = khoảng giá × đòn bẩy × 100.
  const pct = r.stopField === "slMarginPct" ? maxStop.mul(r.leverage).mul(100) : maxStop.mul(100);
  const rounded = pct.mul(10).floor().div(10);
  if (rounded.lt("0.1")) return null;
  return {
    key: "tighter_stop",
    patch: {
      [r.stopField]: rounded.toString(),
      ...(r.stopField === "slMarginPct" ? { slPct: null } : {}),
    },
  };
}

/** Bộ tham số "best" của Review this run → patch config Volume Farm (như `applyReview`, DEC-131). */
export function reviewOption(best: {
  earlyProfitFees: number;
  earlyExitSecs: number;
  minHoldSecs: number;
  maxHoldSecs: number;
  slMarginPct: number;
}): WhatIfOption {
  return {
    key: "review_settings",
    patch: {
      earlyProfitFees: String(best.earlyProfitFees),
      earlyExitSecs: best.earlyExitSecs,
      minHoldSecs: best.minHoldSecs,
      maxHoldSecs: best.maxHoldSecs,
      slMarginPct: String(best.slMarginPct),
      slPct: null,
      earlyProfitUsd: null,
    },
  };
}

/** Phương án cho một việc: luôn có "keep"; phương án sửa tuỳ quy tắc. Không có cách sửa cụ thể → chỉ "keep". */
export function optionsFor(input: {
  rule: NeedsYouRule;
  risk: RiskInput | null;
  reviewBest: Parameters<typeof reviewOption>[0] | null;
}): WhatIfOption[] {
  const out: WhatIfOption[] = [{ key: "keep", patch: {} }];
  if (input.rule === "liquidation_before_stop" && input.risk !== null) {
    const a = lowerLeverageOption(input.risk);
    const b = tighterStopOption(input.risk);
    if (a !== null) out.push(a);
    if (b !== null) out.push(b);
  }
  if (
    (input.rule === "better_review" || input.rule === "max_loss_hit") &&
    input.reviewBest !== null
  )
    out.push(reviewOption(input.reviewBest));
  return out;
}

/** Áp patch lên config (null = xoá field). */
export function applyPatch(
  config: Readonly<Record<string, unknown>>,
  patch: ConfigPatch,
): Record<string, unknown> {
  const removed = new Set(
    Object.entries(patch)
      .filter(([, v]) => v === null)
      .map(([k]) => k),
  );
  const kept = Object.entries(config).filter(([k]) => !removed.has(k));
  const added = Object.entries(patch).filter(([, v]) => v !== null);
  return Object.fromEntries([...kept, ...added]);
}

export type PickReason =
  "safer_best_result" | "better_result" | "keep_is_better" | "not_enough_trades";

/**
 * "My pick" của Desk AI. Quy tắc 1 (rủi ro): chọn phương án sửa có kết quả 7 ngày tốt nhất, kể cả khi kém hơn giữ
 * nguyên (an toàn trước). Quy tắc khác: chọn phương án sửa chỉ khi hơn giữ nguyên ít nhất 0.50 USDC, không thì giữ
 * nguyên. Không có kết quả → không chọn.
 */
export function pickOption(
  rule: NeedsYouRule,
  results: readonly WhatIfOptionResult[],
): { key: WhatIfOptionKey | null; reason: PickReason } {
  const keep = results.find((r) => r.key === "keep");
  const fixes = results.filter((r) => r.key !== "keep" && r.outcome !== null);
  if (keep?.outcome == null || fixes.length === 0)
    return { key: null, reason: "not_enough_trades" };
  const best = fixes.reduce((a, b) =>
    dec(b.outcome?.net ?? "0").gt(dec(a.outcome?.net ?? "0")) ? b : a,
  );
  if (rule === "liquidation_before_stop") return { key: best.key, reason: "safer_best_result" };
  const gain = dec(best.outcome?.net ?? "0").sub(dec(keep.outcome.net));
  return gain.gte(WHATIF_CONFIG.noClearEffectUsd)
    ? { key: best.key, reason: "better_result" }
    : { key: "keep", reason: "keep_is_better" };
}
