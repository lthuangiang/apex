import { Decimal, dec } from "../money";

// AI Desk B+ (DEC-164, DEC-166): việc "Needs you" từ 4 quy tắc + sức khoẻ bot. Hàm thuần: API gom dữ liệu thành
// `DeskBotFacts`, các hàm ở đây quyết định việc nào hiện, mức độ, và các fact (số liệu có nguồn) đi kèm. Câu chữ nằm ở
// messages của web; LLM (M5) chỉ được viết lời quanh `facts`.

/**
 * Ngưỡng của AI Desk B+. Tài liệu chưa nói thì chọn mức an toàn và ghi ở đây (AI_DESK_BPLUS_PROMPT mục 3,
 * DEC-TBD-desk-needs-you, chờ duyệt).
 */
export const NEEDS_YOU_CONFIG = {
  /** Tối đa việc trên trang chủ (DEC-166). */
  maxItems: 3,
  /** "Later" / "Not now": không hiện lại trong chừng này, trừ khi dữ liệu xấu đi (AI_DESK_BPLUS_PROMPT mục 3). */
  snoozeMs: 7 * 86_400_000,
  /** Quy tắc 3: cửa sổ thống kê lượt maker / taker. */
  takerWindowMs: 7 * 86_400_000,
  /** Quy tắc 3: tối thiểu số lượt trong cửa sổ (như REVIEW split, DEC-142). */
  takerMinTrades: 20,
  /** Quy tắc 3: tối thiểu tỷ lệ lượt có chiều taker. */
  takerMinShare: "0.25",
  /** Quy tắc 3: chi phí mỗi 1M của nhóm taker phải cao hơn nhóm maker ít nhất chừng này (USDC). DEC-130: ~10/1M. */
  takerMinCostGapPerMillion: "20",
  /** Quy tắc 3: dữ liệu "xấu đi" khi chênh chi phí tăng thêm chừng này phần (mở lại việc đã hoãn). */
  takerWorseRatio: "0.25",
  /** Quy tắc 4: kết quả Review this run cũ hơn chừng này thì không dùng. */
  reviewMaxAgeMs: 7 * 86_400_000,
  /**
   * Quy tắc 2: mã dừng được coi là "chạm max loss" theo chiến lược (không đổi reason code trong chiến lược). Funding
   * Arb phát `STOP_LOSS` khi chạm max loss (funding-arb/index.ts); Market Making `BUDGET_DONE` là dùng hết ngân sách
   * chi phí theo kế hoạch, không phải lỗ, nên không có ở đây.
   */
  maxLossReasons: {
    default: ["BOT_MAX_LOSS"],
    funding_arb: ["BOT_MAX_LOSS", "STOP_LOSS"],
  } as Readonly<Record<string, readonly string[]>>,
} as const;

/** Mã dừng tính là "chạm max loss" cho chiến lược này (quy tắc 2). */
export const maxLossReasonsOf = (strategy: string): readonly string[] =>
  NEEDS_YOU_CONFIG.maxLossReasons[strategy] ??
  NEEDS_YOU_CONFIG.maxLossReasons.default ?? ["BOT_MAX_LOSS"];

export const NEEDS_YOU_RULES = [
  "liquidation_before_stop",
  "max_loss_hit",
  "taker_costly",
  "better_review",
] as const;
export type NeedsYouRule = (typeof NEEDS_YOU_RULES)[number];

/** Mức độ: số lớn hơn = gấp hơn. Thứ tự hiện: mức độ, rồi thứ tự quy tắc ở trên. */
export const RULE_SEVERITY: Record<NeedsYouRule, number> = {
  liquidation_before_stop: 3,
  max_loss_hit: 3,
  taker_costly: 2,
  better_review: 1,
};

/** Một số liệu có nguồn. LLM chỉ được nhắc số có trong fact (DEC-164 mục 3). */
export interface DeskFact {
  /** `<botId>:<tên>`; ổn định giữa các lần tính. */
  id: string;
  name: string;
  value: string;
  unit: "usdc" | "pct" | "x" | "count" | "per_million" | "text" | "ms";
  source: "config" | "sodex_symbol" | "bot_state" | "fills" | "review" | "estimate";
}

/* --------------------------------------- Quy tắc 1: thanh lý trước stop loss --------------------------------------- */

/** Một bậc margin của SoDEX (`/perps/markets/symbols` › `marginTiers`, đo 2026-11-12). */
export interface MarginTier {
  maxNotionalValue: string;
  maintenanceMarginRate: string;
  maxLeverage: number;
  maintenanceDeduction: string;
}

/**
 * Khoảng giá (tỷ lệ, 0–1) từ giá vào tới giá thanh lý **ước tính** cho margin Isolated, công thức ký quỹ duy trì
 * chuẩn: thanh lý khi margin + lãi/lỗ = notional × MMR − deduction. Long: d = (1/L − MMR + D/N)/(1 − MMR);
 * short: d = (1/L − MMR + D/N)/(1 + MMR). Bỏ qua phí và funding (giá thanh lý thật có thể gần hơn một chút).
 * Không có bậc phù hợp → null. Chỉ dùng nội bộ để so với stop loss (DEC-TBD-desk-liquidation-estimate), không hiện
 * như giá thanh lý (SCREENS.md:166).
 */
export function liquidationDistance(input: {
  tiers: readonly MarginTier[];
  leverage: number;
  notional: string;
  side: "long" | "short";
}): Decimal | null {
  if (input.leverage <= 0) return null;
  const n = dec(input.notional);
  const tier =
    [...input.tiers]
      .sort((a, b) => dec(a.maxNotionalValue).cmp(dec(b.maxNotionalValue)))
      .find((t) => n.lte(dec(t.maxNotionalValue))) ?? null;
  if (tier === null) return null;
  const mmr = dec(tier.maintenanceMarginRate);
  const deduction = n.gt(0) ? dec(tier.maintenanceDeduction).div(n) : new Decimal(0);
  const top = new Decimal(1).div(input.leverage).sub(mmr).add(deduction);
  const d =
    input.side === "long" ? top.div(new Decimal(1).sub(mmr)) : top.div(new Decimal(1).add(mmr));
  return Decimal.max(0, d);
}

/* ------------------------------------------------- Facts của một bot ------------------------------------------------- */

export interface DeskStopCheck {
  /** Khoảng stop loss theo tỷ lệ giá từ giá vào (0–1). */
  stopDistance: string;
  leverage: number;
  marginMode: "isolated" | "cross";
  /** Chiều cần xét; `both` với chiến lược mở hai chiều. */
  side: "long" | "short" | "both";
  /** Notional ước tính để chọn bậc margin. */
  notional: string;
  tiers: readonly MarginTier[];
  /** Mô tả stop để hiện lại (ví dụ "2.5% price"). */
  stopLabel: string;
}

export interface DeskTakerStats {
  trades: number;
  takerTrades: number;
  takerCostPerMillion: number | null;
  makerCostPerMillion: number | null;
}

export interface DeskReviewFact {
  id: string;
  status: string;
  suggestion: "strong" | "none" | "weak" | null;
  appliedVersion: number | null;
  createdAt: number;
  /** Version đang chạy lúc review chạy xong; review cũ hơn version hiện tại thì bỏ. */
  activeVersionAppliedAt: number | null;
  /** Chi phí mỗi 1M: hiện tại và bộ tốt hơn. */
  currentCostPerMillion: number | null;
  bestCostPerMillion: number | null;
}

export interface DeskBotFacts {
  botId: string;
  name: string;
  strategy: string;
  market: string;
  state: string;
  reasonCode: string | null;
  /** Lỗ ròng hiện tại (USDC, có dấu) và mức max loss nếu có. */
  net: string | null;
  maxLoss: string | null;
  fees: string | null;
  /**
   * Lúc bot dừng thật (ms): sự kiện dừng gần nhất do engine ghi (bot_events), không phải `bots.updatedAt` (đổi khi đổi
   * tên, lưu version…). null khi không dừng hoặc không có sự kiện.
   */
  stoppedAt: number | null;
  stop: DeskStopCheck | null;
  taker: DeskTakerStats | null;
  review: DeskReviewFact | null;
  /** Nhận xét của AI Analyst (`deskNotes`): `fees` / `attention` / `fine`. */
  analyst: "fees" | "attention" | "fine";
}

export interface NeedsYouCandidate {
  botId: string;
  rule: NeedsYouRule;
  severity: number;
  facts: DeskFact[];
  /**
   * Mức "xấu" để biết dữ liệu đã xấu đi chưa (mở lại việc đang hoãn): số càng lớn càng xấu. So cùng quy tắc, cùng bot.
   */
  badness: string;
  /** Dấu vân tay dữ liệu: đổi (ví dụ đòn bẩy, lần dừng mới, review mới) → việc mới. */
  fingerprint: string;
}

const fact = (
  botId: string,
  name: string,
  value: Decimal | string | number,
  unit: DeskFact["unit"],
  source: DeskFact["source"],
): DeskFact => ({
  id: `${botId}:${name}`,
  name,
  value: value instanceof Decimal ? value.toDecimalPlaces(6).toString() : String(value),
  unit,
  source,
});

/** Quy tắc 1: khoảng thanh lý ước tính < khoảng stop loss (Isolated). Cross phụ thuộc vốn cả tài khoản: không xét. */
export function ruleLiquidation(b: DeskBotFacts): NeedsYouCandidate | null {
  const s = b.stop;
  if (s?.marginMode !== "isolated" || isStoppedState(b.state)) return null;
  const sides: ("long" | "short")[] = s.side === "both" ? ["long", "short"] : [s.side];
  const liq = sides
    .map((side) =>
      liquidationDistance({ tiers: s.tiers, leverage: s.leverage, notional: s.notional, side }),
    )
    .filter((d): d is Decimal => d !== null)
    .reduce<Decimal | null>((m, d) => (m === null || d.lt(m) ? d : m), null);
  if (liq === null) return null;
  const stop = dec(s.stopDistance);
  if (!liq.lt(stop)) return null;
  return {
    botId: b.botId,
    rule: "liquidation_before_stop",
    severity: RULE_SEVERITY.liquidation_before_stop,
    badness: stop.sub(liq).toString(),
    fingerprint: `${String(s.leverage)}:${stop.toString()}`,
    facts: [
      fact(b.botId, "leverage", s.leverage, "x", "config"),
      fact(b.botId, "stopDistancePct", stop.mul(100), "pct", "config"),
      fact(b.botId, "stopLabel", s.stopLabel, "text", "config"),
      fact(b.botId, "liquidationDistancePct", liq.mul(100), "pct", "estimate"),
      fact(b.botId, "marginMode", s.marginMode, "text", "config"),
    ],
  };
}

const isStoppedState = (state: string): boolean => state === "stopped" || state === "archived";

/** Quy tắc 2: bot dừng vì chạm max loss (engine làm; giao diện ghi "Bot stopped", không ghi là AI). */
export function ruleMaxLoss(b: DeskBotFacts): NeedsYouCandidate | null {
  if (b.reasonCode === null || !maxLossReasonsOf(b.strategy).includes(b.reasonCode)) return null;
  if (b.state !== "paused" && b.state !== "stopped") return null;
  // Fact giữ mã thật (ví dụ STOP_LOSS của Funding Arb).
  const facts = [fact(b.botId, "reasonCode", b.reasonCode, "text", "bot_state")];
  if (b.maxLoss !== null) facts.push(fact(b.botId, "maxLoss", dec(b.maxLoss), "usdc", "config"));
  if (b.net !== null) facts.push(fact(b.botId, "net", dec(b.net), "usdc", "bot_state"));
  if (b.fees !== null) facts.push(fact(b.botId, "fees", dec(b.fees), "usdc", "bot_state"));
  return {
    botId: b.botId,
    rule: "max_loss_hit",
    severity: RULE_SEVERITY.max_loss_hit,
    badness: b.net === null ? "0" : dec(b.net).neg().toString(),
    fingerprint: String(b.stoppedAt ?? 0),
    facts,
  };
}

/** Quy tắc 3: lượt có chiều taker nhiều và đắt hơn rõ rệt (cách tính DEC-130, cờ maker trên fill SoDEX). */
export function ruleTaker(b: DeskBotFacts): NeedsYouCandidate | null {
  const t = b.taker;
  const c = NEEDS_YOU_CONFIG;
  if (t === null || t.trades < c.takerMinTrades) return null;
  if (t.takerCostPerMillion === null || t.makerCostPerMillion === null) return null;
  const share = new Decimal(t.takerTrades).div(t.trades);
  const gap = new Decimal(t.takerCostPerMillion).sub(t.makerCostPerMillion);
  if (share.lt(c.takerMinShare) || gap.lt(c.takerMinCostGapPerMillion)) return null;
  return {
    botId: b.botId,
    rule: "taker_costly",
    severity: RULE_SEVERITY.taker_costly,
    badness: gap.toString(),
    fingerprint: "taker",
    facts: [
      fact(b.botId, "trades", t.trades, "count", "fills"),
      fact(b.botId, "takerTrades", t.takerTrades, "count", "fills"),
      fact(b.botId, "takerSharePct", share.mul(100), "pct", "fills"),
      // 2 số lẻ: LLM (M5) không được nhắc số kiểu 12.345678901.
      fact(
        b.botId,
        "takerCostPerMillion",
        new Decimal(t.takerCostPerMillion).toDecimalPlaces(2),
        "per_million",
        "fills",
      ),
      fact(
        b.botId,
        "makerCostPerMillion",
        new Decimal(t.makerCostPerMillion).toDecimalPlaces(2),
        "per_million",
        "fills",
      ),
    ],
  };
}

/** Quy tắc 4: Review this run có bộ tốt hơn rõ ràng (`strong`, DEC-142), chưa áp dụng, còn mới, đúng version. */
export function ruleReview(b: DeskBotFacts, now: number): NeedsYouCandidate | null {
  const r = b.review;
  if (r?.status !== "done" || r.suggestion !== "strong" || r.appliedVersion !== null) return null;
  if (now - r.createdAt > NEEDS_YOU_CONFIG.reviewMaxAgeMs) return null;
  if (r.activeVersionAppliedAt !== null && r.createdAt < r.activeVersionAppliedAt) return null;
  const facts = [fact(b.botId, "reviewId", r.id, "text", "review")];
  if (r.currentCostPerMillion !== null)
    facts.push(
      fact(b.botId, "currentCostPerMillion", r.currentCostPerMillion, "per_million", "review"),
    );
  if (r.bestCostPerMillion !== null)
    facts.push(fact(b.botId, "bestCostPerMillion", r.bestCostPerMillion, "per_million", "review"));
  return {
    botId: b.botId,
    rule: "better_review",
    severity: RULE_SEVERITY.better_review,
    badness: "0",
    fingerprint: r.id,
    facts,
  };
}

export function evaluateBot(b: DeskBotFacts, now: number): NeedsYouCandidate[] {
  return [ruleLiquidation(b), ruleMaxLoss(b), ruleTaker(b), ruleReview(b, now)].filter(
    (x): x is NeedsYouCandidate => x !== null,
  );
}

/* ------------------------------------------- Sức khoẻ bot và chọn việc ------------------------------------------- */

export const BOT_HEALTH = ["healthy", "watch", "needs_you"] as const;
export type BotHealth = (typeof BOT_HEALTH)[number];

/** Có việc Needs you (kể cả đang hoãn) → needs_you; AI Analyst nhắc (phí / cần chú ý) → watch; còn lại healthy. */
export function botHealth(b: DeskBotFacts, candidates: readonly NeedsYouCandidate[]): BotHealth {
  if (candidates.some((c) => c.botId === b.botId)) return "needs_you";
  if (b.analyst !== "fine") return "watch";
  return "healthy";
}

/** Việc đã lưu (bảng `desk_items`) để biết đang hoãn hay không. */
export interface StoredItem {
  botId: string;
  rule: NeedsYouRule;
  fingerprint: string;
  badness: string;
  snoozedAt: number | null;
}

/**
 * Việc đang hoãn mà dữ liệu xấu đi thì hiện lại: fingerprint đổi (lần dừng mới, đòn bẩy đổi, review mới), hoặc mức xấu
 * tăng quá ngưỡng (quy tắc 3).
 */
export function isSnoozed(
  c: NeedsYouCandidate,
  stored: StoredItem | undefined,
  now: number,
): boolean {
  if (stored?.snoozedAt == null) return false;
  if (now - stored.snoozedAt >= NEEDS_YOU_CONFIG.snoozeMs) return false;
  if (stored.fingerprint !== c.fingerprint) return false;
  const before = dec(stored.badness);
  const after = dec(c.badness);
  if (
    c.rule === "taker_costly" &&
    before.gt(0) &&
    after.gt(before.mul(new Decimal(1).add(NEEDS_YOU_CONFIG.takerWorseRatio)))
  )
    return false;
  if (c.rule === "liquidation_before_stop" && after.gt(before)) return false;
  return true;
}

/** Tối đa 3 việc không hoãn, xếp theo mức độ rồi thứ tự quy tắc. */
export function pickNeedsYou(
  candidates: readonly NeedsYouCandidate[],
  stored: readonly StoredItem[],
  now: number,
): NeedsYouCandidate[] {
  const key = (c: { botId: string; rule: string }) => `${c.botId}:${c.rule}`;
  const byKey = new Map(stored.map((s) => [key(s), s]));
  return candidates
    .filter((c) => !isSnoozed(c, byKey.get(key(c)), now))
    .sort(
      (a, b) =>
        b.severity - a.severity ||
        NEEDS_YOU_RULES.indexOf(a.rule) - NEEDS_YOU_RULES.indexOf(b.rule) ||
        a.botId.localeCompare(b.botId),
    )
    .slice(0, NEEDS_YOU_CONFIG.maxItems);
}
