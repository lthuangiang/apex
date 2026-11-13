import { Decimal, dec } from "../money";

import { episodesOf, type Episode, type LeaderFill } from "./episodes";
import { isPerp, sodexMarketOf, type CoinIndex } from "./markets";

// Thống kê trader Copy Trading v1 (DEC-163 mục 3–5). Chỉ USD, không %. Thiếu dữ liệu → null (UI: "Not enough
// trades" / "Not available"), không bao giờ 0 thay cho "không biết" (quy tắc 1.8).

export const LEADER_STATS = {
  windowDays: 30,
  /** Dưới chừng này episode đã đóng thì không có typical hold. */
  minEpisodesForHold: 10,
  /** Dưới chừng này episode đã đóng thì không có win rate, và trader bị ẩn. */
  minEpisodes: 20,
  /** Typical hold dưới mức này: copy trễ vài giây không theo kịp, ẩn (minHoldFilter). */
  minHoldMs: 15 * 60_000,
  /** Tỷ lệ notional ở market SoDEX có, dưới mức này thì ẩn. */
  minCoverage: "0.5",
  /** Steady: episode tốt nhất chiếm tối đa chừng này phần lợi nhuận. */
  maxTopShare: "0.6",
  /** Hyperliquid chỉ trả 10.000 fill gần nhất (docs/COPY_TRADING_DATA.md). */
  fillCap: 10_000,
} as const;

/** Funding đã trả/nhận (`userFunding`): `usdc` dương = nhận. */
export interface LeaderFunding {
  coin: string;
  time: number;
  usdc: string;
}

export interface LeaderStats {
  /** Σ realized − phí + funding trong 30 ngày (USD). */
  profit: string;
  /** Mức sụt lớn nhất của đường profit cộng dồn theo giờ (USD, số dương). */
  worstDip: string;
  /** Trung vị thời lượng episode đã đóng (ms); null khi < 10 episode. */
  typicalHoldMs: number | null;
  /** Episode lãi / episode đã đóng (0–1, chuỗi); null khi < 20 episode. */
  winRate: string | null;
  wins: number;
  closedEpisodes: number;
  /** Episode lãi nhất / tổng lãi của các episode lãi (0–1); null khi không có episode lãi. */
  topTradeShare: string | null;
  /** Phần notional perp ở market SoDEX có (0–1); null khi không có fill perp. */
  coverage: string | null;
  /** Số lần chính ví bị thanh lý trong 30 ngày. */
  liquidations: number;
  /** Trung vị notional vào lệnh của episode (USD); null khi không có episode mở trong cửa sổ. */
  medianEntryNotional: string | null;
  /** Market SoDEX mà trader giao dịch (copy được), xếp theo notional giảm dần. */
  markets: string[];
  /**
   * Số episode đã đóng trong 30 ngày theo market SoDEX (cột "Trader's trades · 30D", DEC-TBD-copy-pick-markets). Thiếu
   * ở bản ghi cũ (trước khi có field) → web hiện "Not available", không bao giờ 0.
   */
  episodesByMarket?: Record<string, number>;
  /** Coin perp (gồm HIP-3) SoDEX không có. */
  unlistedCoins: string[];
  /** Lợi nhuận cộng dồn theo ngày (cho biểu đồ "Profit over time"), mỗi phần tử `[ms đầu ngày, USD]`. */
  dailyCurve: [number, string][];
  /** Chạm trần 10.000 fill: lịch sử 30 ngày không đủ. */
  historyIncomplete: boolean;
  fills: number;
}

const HOUR = 3_600_000;
const DAY = 86_400_000;

function median(values: readonly Decimal[]): Decimal | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a.cmp(b));
  const mid = Math.floor(s.length / 2);
  const hi = s[mid];
  const lo = s[mid - 1];
  if (hi === undefined) return null;
  return s.length % 2 === 1 || lo === undefined ? hi : lo.add(hi).div(2);
}

export interface StatsInput {
  fills: readonly LeaderFill[];
  funding: readonly LeaderFunding[];
  now: number;
  index: CoinIndex;
  /** Fetcher dừng ở trần fill của Hyperliquid trước khi tới đầu cửa sổ. */
  historyIncomplete: boolean;
}

export function leaderStats(input: StatsInput): LeaderStats {
  const from = input.now - LEADER_STATS.windowDays * DAY;
  const fills = input.fills.filter((f) => f.time >= from && f.time <= input.now && isPerp(f.coin));
  const funding = input.funding.filter(
    (f) => f.time >= from && f.time <= input.now && isPerp(f.coin),
  );
  const episodes = episodesOf(fills);

  // Funding gán vào episode cùng coin có khoảng thời gian chứa nó (cho win rate / top share).
  const net = new Map<Episode, Decimal>(episodes.map((e) => [e, e.net]));
  for (const p of funding) {
    const e = episodes.find(
      (x) =>
        x.coin === p.coin &&
        (x.openedAt ?? from) <= p.time &&
        (x.closedAt === null || p.time <= x.closedAt),
    );
    if (e !== undefined) net.set(e, (net.get(e) ?? e.net).add(dec(p.usdc)));
  }

  // Profit + đường cộng dồn theo giờ.
  const hourly = new Map<number, Decimal>();
  const bump = (t: number, v: Decimal): void => {
    const h = Math.floor(t / HOUR) * HOUR;
    hourly.set(h, (hourly.get(h) ?? new Decimal(0)).add(v));
  };
  let profit = new Decimal(0);
  for (const f of fills) {
    const v = dec(f.closedPnl).sub(dec(f.fee));
    profit = profit.add(v);
    bump(f.time, v);
  }
  for (const p of funding) {
    profit = profit.add(dec(p.usdc));
    bump(p.time, dec(p.usdc));
  }
  let run = new Decimal(0);
  let peak = new Decimal(0);
  let dip = new Decimal(0);
  const daily = new Map<number, Decimal>();
  for (const h of [...hourly.keys()].sort((a, b) => a - b)) {
    run = run.add(hourly.get(h) ?? 0);
    if (run.gt(peak)) peak = run;
    if (peak.sub(run).gt(dip)) dip = peak.sub(run);
    daily.set(Math.floor(h / DAY) * DAY, run);
  }

  const closed = episodes.filter((e) => e.closedAt !== null && e.openedAt !== null);
  const holds = closed.map((e) => new Decimal((e.closedAt ?? 0) - (e.openedAt ?? 0)));
  const holdMed = closed.length >= LEADER_STATS.minEpisodesForHold ? median(holds) : null;
  const wins = closed.filter((e) => (net.get(e) ?? e.net).gt(0)).length;
  const winRate =
    closed.length >= LEADER_STATS.minEpisodes
      ? new Decimal(wins).div(closed.length).toDecimalPlaces(4).toString()
      : null;

  const positives = episodes.map((e) => net.get(e) ?? e.net).filter((v) => v.gt(0));
  const posSum = positives.reduce((a, b) => a.add(b), new Decimal(0));
  const best = positives.reduce((a, b) => (b.gt(a) ? b : a), new Decimal(0));
  const topTradeShare = posSum.gt(0) ? best.div(posSum).toDecimalPlaces(4).toString() : null;

  // Coverage theo notional mọi fill perp (cả HIP-3, SoDEX không có): trader chủ yếu đánh HIP-3 có coverage thấp.
  const byMarket = new Map<string, Decimal>();
  const unlisted = new Set<string>();
  let total = new Decimal(0);
  let listed = new Decimal(0);
  for (const f of fills) {
    const n = dec(f.px).mul(dec(f.sz));
    total = total.add(n);
    const m = sodexMarketOf(f.coin, input.index);
    if (m === null) {
      unlisted.add(f.coin);
      continue;
    }
    listed = listed.add(n);
    byMarket.set(m, (byMarket.get(m) ?? new Decimal(0)).add(n));
  }

  const liquidations = new Set(
    fills.filter((f) => f.liquidatedSelf).map((f) => `${f.coin}:${String(f.time)}`),
  ).size;
  const episodesByMarket: Record<string, number> = {};
  for (const e of closed) {
    const m = sodexMarketOf(e.coin, input.index);
    if (m !== null) episodesByMarket[m] = (episodesByMarket[m] ?? 0) + 1;
  }
  const entries = episodes
    .filter((e) => e.openedAt !== null && e.entryNotional.gt(0))
    .map((e) => e.entryNotional);
  const entryMed = median(entries);

  return {
    profit: profit.toDecimalPlaces(2).toString(),
    worstDip: dip.toDecimalPlaces(2).toString(),
    typicalHoldMs: holdMed === null ? null : holdMed.round().toNumber(),
    winRate,
    wins,
    closedEpisodes: closed.length,
    topTradeShare,
    coverage: total.gt(0) ? listed.div(total).toDecimalPlaces(4).toString() : null,
    liquidations,
    medianEntryNotional: entryMed === null ? null : entryMed.toDecimalPlaces(2).toString(),
    markets: [...byMarket.entries()].sort((a, b) => b[1].cmp(a[1])).map(([m]) => m),
    episodesByMarket,
    unlistedCoins: [...unlisted].sort(),
    dailyCurve: [...daily.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([d, v]) => [d, v.toDecimalPlaces(2).toString()]),
    historyIncomplete: input.historyIncomplete,
    fills: fills.length,
  };
}

/** Lý do ẩn khỏi danh sách (DEC-163 mục 4). */
export const HIDDEN_REASONS = ["fast", "few_trades", "vault", "low_coverage"] as const;
export type HiddenReason = (typeof HIDDEN_REASONS)[number];

export const TRADER_TABS = ["steady", "top", "long", "all"] as const;
export type TraderTab = (typeof TRADER_TABS)[number];

export interface Classified {
  hidden: HiddenReason[];
  /** Tab trader xuất hiện (rỗng khi bị ẩn). */
  tabs: TraderTab[];
  /** Điểm xếp hạng Steady = profit ÷ worst dip; null khi không thuộc Steady. */
  steadyScore: string | null;
}

export function classify(s: LeaderStats, isVault: boolean): Classified {
  const hidden: HiddenReason[] = [];
  if (s.closedEpisodes < LEADER_STATS.minEpisodes) hidden.push("few_trades");
  if (s.typicalHoldMs !== null && s.typicalHoldMs < LEADER_STATS.minHoldMs) hidden.push("fast");
  if (isVault) hidden.push("vault");
  if (s.coverage === null || dec(s.coverage).lt(LEADER_STATS.minCoverage))
    hidden.push("low_coverage");
  if (hidden.length > 0) return { hidden, tabs: [], steadyScore: null };

  // Lịch sử thiếu: số không đáng tin để xếp hạng, chỉ hiện ở All kèm "History incomplete".
  if (s.historyIncomplete) return { hidden, tabs: ["all"], steadyScore: null };

  const tabs: TraderTab[] = ["top", "long", "all"];
  const profit = dec(s.profit);
  // Steady dành cho người mới: bị thanh lý trong 30 ngày thì không vào (vẫn ở All / Top, nhãn "Liquidated recently").
  const steady =
    profit.gt(0) &&
    s.liquidations === 0 &&
    s.topTradeShare !== null &&
    dec(s.topTradeShare).lte(LEADER_STATS.maxTopShare);
  if (!steady) return { hidden, tabs, steadyScore: null };
  // Không có sụt (đường chỉ đi lên): coi sụt = 1 USD để vẫn xếp được, tránh chia cho 0.
  const dip = Decimal.max(dec(s.worstDip), 1);
  return {
    hidden,
    tabs: ["steady", ...tabs],
    steadyScore: profit.div(dip).toDecimalPlaces(4).toString(),
  };
}

/** Typical hold đạt minHoldFilter (DEC-163 mục 5); null hold = chưa đủ dữ liệu = không đạt. */
export const meetsMinHold = (s: Pick<LeaderStats, "typicalHoldMs">): boolean =>
  s.typicalHoldMs !== null && s.typicalHoldMs >= LEADER_STATS.minHoldMs;
