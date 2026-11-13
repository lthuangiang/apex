import {
  dec,
  FOLLOW_ALERT_GAP_MS,
  type CopyBotOpenedData,
  type CopyBotSkippedData,
  type CopyOpenMove,
  type CopySkipReason,
} from "@drift/shared";
import {
  normalizeCopyState,
  type CopyTradeConfig,
  type CopyTradeState,
  type StrategyEvent,
} from "@drift/strategies";

// Cảnh báo của bot copy (DEC-212, W2b). Hàm thuần: engine gọi trong transaction đang có (upsert
// bot_runtime / ghi bot_events) để thêm dòng outbox. Không bao giờ ném lỗi: dữ liệu lạ thì trả rỗng / null, engine
// bỏ tin (PM điều kiện ii). Không chứa địa chỉ ví hay số dư.

/** Câu log "Skipped" của chiến lược copy-trade → mã lý do. Test dùng đúng câu do chiến lược sinh ra. */
const SKIP_PATTERNS: readonly (readonly [RegExp, CopySkipReason])[] = [
  [/^Signal arrived \d+ ms late\./, "signal_late"],
  [/^Signal too old to open a position\./, "signal_too_old"],
  [/^Price moved more than /, "price_moved"],
  [/^Copy size is below the SoDEX minimum order size\./, "below_minimum"],
  [/^SoDEX rejected the copy order\./, "rejected"],
  [/^No fill within /, "no_fill"],
  [/^This trader now trades too fast to copy/, "min_hold"],
  [/^Not enough SoDEX liquidity near the price/, "low_liquidity"],
];

export function skipReason(why: string): CopySkipReason {
  for (const [re, reason] of SKIP_PATTERNS) if (re.test(why)) return reason;
  return "other";
}

/** State copy ở dạng nhiều market; null nếu không đọc được (không ném lỗi). */
function normalized(config: unknown, raw: unknown): CopyTradeState | null {
  try {
    return normalizeCopyState(config as CopyTradeConfig, raw);
  } catch {
    return null;
  }
}

/**
 * Lệnh mở / tăng / đảo chiều của bot copy vừa xong và có khớp trong bước này: `copied` tăng và lệnh `open` đang chờ
 * của market không còn. Fill phát lại không tới được đây (engine bỏ delta ≤ 0), và `orderDone` phát lại thì chiến lược
 * không đổi state, nên mỗi lệnh sinh tối đa một tin; jobs chống trùng thêm theo (botId, clOrdID).
 */
export function openedAlerts(
  botId: string,
  config: unknown,
  prevRaw: unknown,
  nextRaw: unknown,
  event: StrategyEvent,
): CopyBotOpenedData[] {
  try {
    const prev = normalized(config, prevRaw);
    const next = normalized(config, nextRaw);
    if (prev === null || next === null || !(next.copied > prev.copied)) return [];
    const out: CopyBotOpenedData[] = [];
    for (const [market, before] of Object.entries(prev.markets)) {
      const f = before.inflight;
      if (f?.kind !== "open") continue;
      const after = next.markets[market];
      if (after === undefined || after.inflight?.id === f.id) continue;
      const lastFill =
        event.type === "fill" && event.clOrdID === f.id ? dec(event.quantity) : dec("0");
      const filled = dec(f.filled).add(lastFill);
      if (!filled.gt(0)) continue;
      const posAfter = dec(after.ledger.position);
      if (posAfter.isZero()) continue;
      const posBefore = posAfter.sub(f.side === "buy" ? filled : filled.neg());
      const move: CopyOpenMove = posBefore.isZero()
        ? "opened"
        : posBefore.isNegative() !== posAfter.isNegative()
          ? "flipped"
          : "added";
      out.push({
        botId,
        clOrdID: f.id,
        market,
        move,
        side: posAfter.isNegative() ? "short" : "long",
        size: filled.toString(),
        avgEntry: after.ledger.avgCost,
        at: event.at,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** Market của tín hiệu bị bỏ qua: từ sự kiện, hoặc từ lệnh mà sự kiện nói tới; bot một market thì là market đó. */
export function skipMarket(config: unknown, prevRaw: unknown, event: StrategyEvent): string | null {
  try {
    if ("market" in event && typeof event.market === "string") return event.market;
    const prev = normalized(config, prevRaw);
    if ("clOrdID" in event) {
      const m = prev?.orders[event.clOrdID]?.market;
      if (m !== undefined) return m;
    }
    const markets = (config as { markets?: unknown }).markets;
    return Array.isArray(markets) && markets.length === 1 && typeof markets[0] === "string"
      ? markets[0]
      : null;
  } catch {
    return null;
  }
}

/**
 * Giới hạn tin Skipped: tối đa 1 tin / bot / market / 10 phút. Giữ trong bộ nhớ của runner (không đọc DB trên đường
 * gửi lệnh); engine khởi động lại hay chuyển shard thì nhiều nhất thêm một tin.
 */
export class SkipGate {
  readonly #last = new Map<string, number>();
  allow(market: string | null, now: number): boolean {
    const key = market ?? "*";
    const prev = this.#last.get(key);
    if (prev !== undefined && now - prev < FOLLOW_ALERT_GAP_MS) return false;
    this.#last.set(key, now);
    return true;
  }
}

export function skippedAlert(
  botId: string,
  market: string | null,
  why: string,
  at: number,
): CopyBotSkippedData {
  return { botId, market, reason: skipReason(why), why, at };
}
