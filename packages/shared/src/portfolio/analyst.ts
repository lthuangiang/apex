import { formatDecimal } from "../format";
import { Decimal, dec, type DecimalInput } from "../money";

import type { PortfolioValue } from "./value";

// AI Analyst (SCREENS.md mục 9.8, DEC-41): quy tắc tất định trên dữ liệu thật. Mỗi insight tách "dữ liệu quan
// sát", "diễn giải" và "việc nên kiểm tra", kèm nguồn và thời điểm. Không dự báo giá, không hứa lợi nhuận.

export const ANALYST_THRESHOLDS = {
  concentrationPct: 50,
  feeShareOfLoss: 0.5,
  minDaysForComparison: 14,
} as const;

export interface AnalystBot {
  id: string;
  name: string;
  state: string;
  needsAttention: boolean;
  /** Thời điểm bot cần chú ý (bot_events gần nhất), ms. */
  attentionSince: number | null;
  netPnl: string | null;
  fees: string | null;
  fills: number;
  firstFillAt: number | null;
  quote: string;
}

export interface AnalystInput {
  now: number;
  portfolio: PortfolioValue | null;
  portfolioAt: number | null;
  bots: readonly AnalystBot[];
  limitsBreached: number | null;
  /** Múi giờ trong Settings › Profile; mọi mốc giờ trong câu chữ dùng giờ này (UI_REVIEW J7). */
  timeZone?: string;
}

export interface Insight {
  id: string;
  title: string;
  subject: string;
  attention: boolean;
  observed: string;
  interpretation: string;
  check: string;
  sources: string;
  link: { kind: "portfolio" | "bot" | "orders"; botId?: string } | null;
}

export interface AnalystOutput {
  briefing: string | null;
  basis: string;
  insights: Insight[];
  /** Phần "Not enough data yet". */
  notEnough: { observed: string; progress: string } | null;
}

const n = (v: DecimalInput, digits = 2, sign = false) =>
  formatDecimal(dec(v).toDecimalPlaces(digits, Decimal.ROUND_HALF_UP), {
    locale: "en-US",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    signDisplay: sign ? "exceptZero" : "auto",
  }) ?? "";
/** "Oct 29, 13:38:28" theo múi giờ của người dùng, cùng dạng `formatDateTime` ở web. */
const clock = (ms: number, timeZone: string) =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).format(new Date(ms));
/** "1 fill", "2 fills" (UI_REVIEW J7). */
const count = (k: number, one: string, other = `${one}s`) =>
  `${String(k)} ${k === 1 ? one : other}`;
const DAY = 86_400_000;

export function analyze(input: AnalystInput): AnalystOutput {
  const insights: Insight[] = [];
  const p = input.portfolio;
  const tz = input.timeZone ?? "UTC";
  const time = (ms: number) => clock(ms, tz);
  const at = input.portfolioAt === null ? "" : time(input.portfolioAt);

  // 1. Tập trung vào một tài sản (theo notional của vị thế Perps).
  if (p !== null) {
    const priced = p.positions.filter(
      (x): x is typeof x & { notional: string } => x.notional !== null,
    );
    const gross = priced.reduce((s, x) => s.add(x.notional), new Decimal(0));
    const top = [...priced].sort((a, b) => dec(b.notional).comparedTo(a.notional))[0];
    if (top !== undefined && gross.gt(0)) {
      const share = dec(top.notional).div(gross).mul(100);
      if (share.gte(ANALYST_THRESHOLDS.concentrationPct) && priced.length > 1) {
        insights.push({
          id: "concentration",
          title: "Most of your exposure is one asset",
          subject: "Portfolio",
          attention: false,
          observed: `${top.market} ${top.side} is ${n(top.notional)} of ${n(gross)} USDC gross exposure (${n(share, 0)}%).`,
          interpretation: `Your equity will mostly follow ${top.market} price.`,
          check:
            "Confirm this concentration is intended. A concentration limit can’t be set until the backend supports it.",
          sources: `positions ${at} · mark prices ${at}`,
          link: { kind: "portfolio" },
        });
      }
    }
  }

  // 2. Bot đang lỗ chủ yếu vì phí.
  for (const b of input.bots) {
    if (b.netPnl === null || b.fees === null || b.fills === 0) continue;
    const net = dec(b.netPnl);
    if (!net.lt(0) || !dec(b.fees).gte(net.abs().mul(ANALYST_THRESHOLDS.feeShareOfLoss))) continue;
    const days =
      b.firstFillAt === null ? null : Math.max(1, Math.round((input.now - b.firstFillAt) / DAY));
    insights.push({
      id: `fees:${b.id}`,
      title: `${b.name} is losing mostly to fees`,
      subject: b.name,
      attention: false,
      observed: `Profit ${n(net, 4, true)} ${b.quote}${days === null ? "" : ` over ${count(days, "day")}`}. ${count(b.fills, "fill")} paid ${n(b.fees, 4)} ${b.quote} in fees.`,
      interpretation: "Fees explain most of the loss.",
      check:
        "Review the bot’s settings against the fee rate in Strategy Lab. DRIFT will not change it for you.",
      sources: `${count(b.fills, "fill")} · bot ledger`,
      link: { kind: "orders", botId: b.id },
    });
  }

  // 3. Bot cần chú ý (ví dụ giá ra khỏi khoảng grid).
  for (const b of input.bots) {
    if (!b.needsAttention) continue;
    const since = b.attentionSince === null ? "" : ` since ${time(b.attentionSince)}`;
    insights.push({
      id: `attention:${b.id}`,
      title: `${b.name} needs attention`,
      subject: b.name,
      attention: true,
      observed: `The bot flagged that it needs attention${since}.`,
      interpretation:
        "The bot is doing what it was set to do. Its capital may be waiting, not trading.",
      check:
        "Decide whether to wait, change the settings, or pause the bot. Each choice goes through a review step.",
      sources: `bot status ${at}`,
      link: { kind: "bot", botId: b.id },
    });
  }

  // 4. Chưa đủ dữ liệu để so sánh bot.
  const withFills = input.bots.filter((b) => b.firstFillAt !== null);
  const short = withFills.filter(
    (b) => input.now - (b.firstFillAt ?? input.now) < ANALYST_THRESHOLDS.minDaysForComparison * DAY,
  );
  const notEnough =
    withFills.length >= 2 && short.length > 0
      ? {
          observed: `Comparing your bots needs at least ${String(ANALYST_THRESHOLDS.minDaysForComparison)} days of fills each. ${short
            .map(
              (b) =>
                `${b.name} has ${count(Math.floor((input.now - (b.firstFillAt ?? input.now)) / DAY), "day")}`,
            )
            .join("; ")}.`,
          progress: `${String(Math.min(...short.map((b) => Math.floor((input.now - (b.firstFillAt ?? input.now)) / DAY))))} of ${count(ANALYST_THRESHOLDS.minDaysForComparison, "day")}`,
        }
      : null;

  // Tóm tắt trong ngày.
  const parts: string[] = [];
  // Không mở đầu bằng % thay đổi equity: SoDEX không có lịch sử nạp/rút nên số đó gồm cả tiền nạp
  // (UI_REVIEW J1, quy tắc 1.8).
  const running = input.bots.filter((b) => b.state === "running").length;
  const paused = input.bots.filter((b) => b.state === "paused").length;
  if (input.bots.length > 0)
    parts.push(`${count(running, "bot is", "bots are")} running and ${String(paused)} paused.`);
  if (input.limitsBreached !== null)
    parts.push(
      input.limitsBreached === 0
        ? "All server-enforced limits pass."
        : `${String(input.limitsBreached)} server-enforced limit${input.limitsBreached === 1 ? " is" : "s are"} breached.`,
    );
  return {
    briefing: parts.length === 0 ? null : parts.join(" "),
    basis: `Based on data as of ${at === "" ? "—" : at} · ${count(p?.positions.length ?? 0, "position")}, ${count(input.bots.length, "bot")}`,
    insights,
    notEnough,
  };
}
