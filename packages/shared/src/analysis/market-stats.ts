import { dec, Decimal } from "../money";

// Thống kê thị trường theo ngày (RECO_ENGINE.md mục 10.1 C; bảng `market_stats_daily`). Hàm thuần.
// σ, trend, rangeScore là số thống kê (không phải tiền) nên tính bằng float; giá phân vị dùng Decimal.
// Định nghĩa chi tiết khi tài liệu chưa nói rõ: DEC-34.

export interface DailyClose {
  /** Đầu ngày UTC, ms. */
  day: number;
  close: string;
}

export interface FundingPoint {
  at: number;
  rate: string;
}

export interface MarketStats {
  /** σ của log return theo ngày, 30 ngày gần nhất (độ lệch chuẩn mẫu). */
  sigma30: number | null;
  p5: string | null;
  p50: string | null;
  p95: string | null;
  trend: number | null;
  rangeScore: number | null;
  fundingAvg7d: string | null;
  fundingPos21: number | null;
}

const WINDOW = 30;
const RANGE_DAYS = 180;
const DAY = 86_400_000;

/** Phân vị nội suy tuyến tính (cùng cách với numpy `linear`). */
export function percentile(values: readonly string[], p: number): string | null {
  if (values.length === 0) return null;
  const sorted = values.map((v) => dec(v)).sort((a, b) => a.comparedTo(b));
  // Rank tính bằng Decimal để giá phân vị không lẫn sai số float.
  const rank = new Decimal(p).div(100).mul(sorted.length - 1);
  const lo = rank.floor().toNumber();
  const hi = rank.ceil().toNumber();
  const a = sorted[lo] ?? new Decimal(0);
  const b = sorted[hi] ?? a;
  return a.add(b.sub(a).mul(rank.sub(lo))).toString();
}

function stdev(xs: readonly number[]): number | null {
  if (xs.length < 2) return null;
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1));
}

/**
 * `closes` theo thứ tự thời gian tăng dần, mỗi ngày một giá đóng cửa. `funding` là các kỳ funding
 * đã ghi được (Perps); Spot truyền mảng rỗng. `now` là thời điểm tính.
 */
export function computeMarketStats(
  closes: readonly DailyClose[],
  funding: readonly FundingPoint[],
  now: number,
): MarketStats {
  const prices = closes.map((c) => Number(c.close));
  const last31 = prices.slice(-(WINDOW + 1));
  const returns = last31.slice(1).map((p, i) => Math.log(p / (last31[i] ?? p)));
  const sigma = returns.length === WINDOW ? stdev(returns) : null;
  const window = closes.slice(-WINDOW).map((c) => c.close);
  const enough = window.length === WINDOW;

  let trend: number | null = null;
  const lastPrice = prices.at(-1);
  const ago = prices.at(-(WINDOW + 1));
  if (sigma !== null && sigma > 0 && lastPrice !== undefined && ago !== undefined) {
    trend = Math.log(lastPrice / ago) / (sigma * Math.sqrt(WINDOW));
  }

  // rangeScore: tỷ lệ ngày (trong 180 ngày gần nhất, có đủ MA30) mà |ln(close / MA30)| ≤ 1.5·σ·√30.
  let rangeScore: number | null = null;
  if (sigma !== null) {
    const band = 1.5 * sigma * Math.sqrt(WINDOW);
    const start = Math.max(WINDOW - 1, prices.length - RANGE_DAYS);
    let inside = 0;
    let counted = 0;
    for (let i = start; i < prices.length; i += 1) {
      const slice = prices.slice(i - WINDOW + 1, i + 1);
      const ma = slice.reduce((s, p) => s + p, 0) / slice.length;
      const price = prices[i] ?? ma;
      counted += 1;
      if (Math.abs(Math.log(price / ma)) <= band) inside += 1;
    }
    rangeScore = counted === 0 ? null : inside / counted;
  }

  const sortedFunding = [...funding].sort((a, b) => a.at - b.at);
  const week = sortedFunding.filter((f) => f.at > now - 7 * DAY);
  const fundingAvg7d =
    week.length === 0
      ? null
      : week
          .reduce((s, f) => s.add(f.rate), new Decimal(0))
          .div(week.length)
          .toString();
  const last21 = sortedFunding.slice(-21);
  const fundingPos21 =
    last21.length < 21 ? null : last21.filter((f) => dec(f.rate).gt(0)).length / 21;

  return {
    sigma30: sigma,
    p5: enough ? percentile(window, 5) : null,
    p50: enough ? percentile(window, 50) : null,
    p95: enough ? percentile(window, 95) : null,
    trend,
    rangeScore,
    fundingAvg7d,
    fundingPos21,
  };
}
