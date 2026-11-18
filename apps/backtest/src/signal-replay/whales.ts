import { Decimal } from "@drift/shared";

import { alreadyOpen, enterAndWalk, type MarketContext } from "./market";
import { blankTrade, type Direction, type SignalTrade } from "./types";

// A · Cá voi (#274, #263). Sự kiện từ `leader_events` (Hyperliquid). Luật v1 chốt trước khi xem kết quả:
// - chỉ `open` / `add` / `flip` (mở hoặc tăng vị thế), market có trên SoDEX;
// - DeskLabs thấy sự kiện trong 5 phút sau fill của cá voi (sự kiện thấy muộn hơn là dữ liệu nạp bù lúc mới theo dõi ví
//   hoặc lúc máy thu dừng: không giao dịch được thật, chỉ đếm);
// - chống survivorship: ví phải có trong một lần `leaderboard_runs` (status ok) đã XONG trước lúc thấy sự kiện; chất lượng
//   ví lấy từ `leader_stats_daily` của lần đó (không bao giờ từ dữ liệu sau sự kiện);
// - notional thay đổi ≥ 3 × "usual size" của ví = `medianEntryNotional` của lần xếp hạng đó;
// - chiều = chiều vị thế của cá voi sau sự kiện; giữ tối đa 4 giờ; TP / SL theo luật chung (`TRADE_RULES_V1`).
// Điểm (không có ngưỡng, chỉ để phân tích theo nhóm): kích thước 35, chất lượng ví 40, cá voi khác cùng chiều 30 phút 25.

const MIN = 60_000;

export const WHALE_RULES_V1 = {
  version: "A-v1",
  kinds: ["open", "add", "flip"] as readonly string[],
  maxDelayMs: 5 * MIN,
  minSizeMultiple: new Decimal(3),
  maxHoldMs: 4 * 3_600_000,
  consensusWindowMs: 30 * MIN,
  weights: { size: 0.35, quality: 0.4, consensus: 0.25 },
} as const;

export interface WhaleEvent {
  id: string;
  source: string;
  address: string;
  market: string;
  kind: string;
  positionBefore: Decimal;
  positionAfter: Decimal;
  notional: Decimal;
  price: Decimal;
  at: number;
  seenAt: number;
}

/** Một dòng `leader_stats_daily` ghép với lần `leaderboard_runs` đã xong của ngày đó. */
export interface WalletSnapshot {
  date: string;
  finishedAt: number;
  profit: Decimal;
  winRate: Decimal | null;
  medianEntryNotional: Decimal | null;
  steadyScore: number | null;
  hidden: readonly string[];
}

/** Khoá ví: nguồn + địa chỉ chữ thường. */
export const walletKey = (source: string, address: string) => `${source}:${address.toLowerCase()}`;

/** Lần xếp hạng gần nhất đã xong tại / trước `t` (mảng xếp theo finishedAt tăng dần); không có → null. */
export function snapshotAsOf(
  history: readonly WalletSnapshot[] | undefined,
  t: number,
): WalletSnapshot | null {
  if (history === undefined) return null;
  let found: WalletSnapshot | null = null;
  for (const s of history) {
    if (s.finishedAt <= t) found = s;
    else break;
  }
  return found;
}

export interface WhaleFunnel {
  events: number;
  notOpenOrAdd: number;
  late: number;
  notInLeaderboardBefore: number;
  noUsualSize: number;
  belowSize: number;
  signals: number;
}

export const emptyWhaleFunnel = (): WhaleFunnel => ({
  events: 0,
  notOpenOrAdd: 0,
  late: 0,
  notInLeaderboardBefore: 0,
  noUsualSize: 0,
  belowSize: 0,
  signals: 0,
});

/** Điểm chất lượng ví: lợi nhuận 30 ngày ≤ 0 → 0; có win rate → win rate; không có → 0.5. */
export function walletQuality(s: WalletSnapshot): number {
  if (s.profit.lte(0)) return 0;
  return s.winRate === null ? 0.5 : Math.min(1, Math.max(0, s.winRate.toNumber()));
}

/** Điểm v1 (0–1): kích thước = min(1, log10(bội)), chất lượng ví, đồng thuận = min(1, số ví khác ÷ 3). */
export function whaleScore(multiple: Decimal, quality: number, others: number): number {
  const w = WHALE_RULES_V1.weights;
  const size = Math.min(1, Math.max(0, Math.log10(multiple.toNumber())));
  const consensus = Math.min(1, others / 3);
  return Math.round((w.size * size + w.quality * quality + w.consensus * consensus) * 100) / 100;
}

const directionOf = (e: WhaleEvent): Direction | null =>
  e.positionAfter.gt(0) ? "long" : e.positionAfter.lt(0) ? "short" : null;

/**
 * Chạy luật A v1 trên các sự kiện của MỘT market (xếp theo seenAt). `wallets` là lịch sử xếp hạng theo ví. Trả lệnh
 * (vào hoặc bị bỏ, kèm lý do) và cộng phễu vào `funnel`.
 */
export function evaluateWhales(
  events: readonly WhaleEvent[],
  wallets: ReadonlyMap<string, readonly WalletSnapshot[]>,
  ctx: MarketContext,
  funnel: WhaleFunnel,
  from = -Infinity,
): SignalTrade[] {
  const rules = WHALE_RULES_V1;
  const sorted = [...events].sort((a, b) => a.seenAt - b.seenAt);
  const eligible: { e: WhaleEvent; dir: Direction }[] = [];
  const out: SignalTrade[] = [];
  let openUntil: number | null = null;
  for (const e of sorted) {
    // Sự kiện trước `from` chỉ dùng cho phần đồng thuận, không tạo lệnh và không vào phễu.
    const inRange = e.seenAt >= from;
    const count = (k: keyof WhaleFunnel) => {
      if (inRange) funnel[k] += 1;
    };
    count("events");
    const dir = directionOf(e);
    if (!rules.kinds.includes(e.kind) || dir === null) {
      count("notOpenOrAdd");
      continue;
    }
    if (e.seenAt - e.at > rules.maxDelayMs) {
      count("late");
      continue;
    }
    const snap = snapshotAsOf(wallets.get(walletKey(e.source, e.address)), e.seenAt);
    if (snap === null) {
      count("notInLeaderboardBefore");
      continue;
    }
    // Ví đủ điều kiện: tính cho đồng thuận của các sự kiện sau, kể cả khi sự kiện này nhỏ.
    const others = new Set(
      eligible
        .filter(
          (x) =>
            x.dir === dir &&
            x.e.address !== e.address &&
            e.seenAt - x.e.seenAt <= rules.consensusWindowMs,
        )
        .map((x) => x.e.address),
    ).size;
    eligible.push({ e, dir });
    while (
      eligible.length > 0 &&
      e.seenAt - (eligible[0]?.e.seenAt ?? e.seenAt) > rules.consensusWindowMs
    )
      eligible.shift();
    if (!inRange) continue;
    if (snap.medianEntryNotional === null || snap.medianEntryNotional.lte(0)) {
      count("noUsualSize");
      continue;
    }
    const multiple = e.notional.div(snap.medianEntryNotional);
    if (multiple.lt(rules.minSizeMultiple)) {
      count("belowSize");
      continue;
    }
    count("signals");
    const quality = walletQuality(snap);
    const t = blankTrade({
      type: "whale",
      variant: "whale_big_move",
      ruleVersion: rules.version,
      asset: e.market,
      direction: dir,
      eventAt: e.at,
      seenAt: e.seenAt,
      maxHoldMs: rules.maxHoldMs,
      what: `Wallet ··${e.address.slice(-8)} ${e.kind === "add" ? "added to" : e.kind === "flip" ? "flipped to" : "opened"} ${dir}, $${e.notional.toDecimalPlaces(0).toString()} · size ${multiple.toDecimalPlaces(1).toString()}× usual`,
      score: whaleScore(multiple, quality, others),
      detail: {
        wallet: `··${e.address.slice(-8)}`,
        kind: e.kind,
        sizeMultiple: multiple.toDecimalPlaces(2).toNumber(),
        walletRankedOn: snap.date,
        walletProfit30d: snap.profit.toDecimalPlaces(0).toNumber(),
        walletWinRate: snap.winRate === null ? null : snap.winRate.toNumber(),
        walletHidden: snap.hidden.join(",") || null,
        walletQuality: quality,
        otherWhalesSameWay30m: others,
        whaleFillPrice: e.price.toString(),
      },
    });
    if (alreadyOpen(openUntil, e.seenAt)) {
      t.skipReason = "A Whales trade on this asset is already open";
      out.push(t);
      continue;
    }
    enterAndWalk(t, ctx);
    if (t.status === "entered" && t.entry !== null) {
      openUntil = t.exitAt;
      t.detail.paidVsWhaleBp = directedPaid(dir, e.price, t.entry);
    }
    out.push(t);
  }
  return out;
}

/** Mình trả hơn giá fill của cá voi bao nhiêu (bp, + = tệ hơn cá voi). Giá cá voi là giá Hyperliquid, chỉ tham khảo. */
function directedPaid(dir: Direction, whale: Decimal, entry: Decimal): number {
  const bp = entry.sub(whale).div(whale).mul(10_000);
  return (dir === "long" ? bp : bp.neg()).toDecimalPlaces(2).toNumber();
}
