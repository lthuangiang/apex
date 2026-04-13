export const config = {
  MODE: "farm", // 'farm' (volume farming, 2-5 min scalps) or 'trade' (signal-filtered, TP/SL based)

  // Exchange
  EXCHANGE: "sodex", // 'sodex' or 'decibel'
  MARKET: "BTC-USD",
  SYMBOL: "BTC-USD",

  // Order sizing (BTC)
  ORDER_SIZE_MIN: 0.003,
  ORDER_SIZE_MAX: 0.005,

  // Signal filtering (trade mode only)
  MIN_CONFIDENCE: 0.65,
  NEUTRAL_ZONE: [0.45, 0.55],
  SIGNAL_THRESHOLD: 1.2,

  // Chart data — 5m candles for short-term momentum
  CHART_INTERVAL: '5m',
  CHART_LIMIT: 30,

  // ── Farm mode ─────────────────────────────────────────────────────────────
  // Goal: maximize volume. Enter frequently, hold 2–5 mins per trade.
  // No confirmation required — enter on first valid signal tick
  FARM_MIN_HOLD_SECS: 120,      // Hold at least 2 mins after fill
  FARM_MAX_HOLD_SECS: 300,      // Force exit after 5 mins
  FARM_TP_USD: 0.5,             // TP $0.5 — đủ cover fee với size nhỏ (fee ~$0.07 per trade)
  FARM_SL_PERCENT: 0.05,        // Stop loss 5% — rộng để không bị stop out sớm
  FARM_SCORE_EDGE: 0.03,        // Min score edge to enter (|score - 0.5| > this)
  FARM_MIN_CONFIDENCE: 0.50,    // Min confidence for fallback signal entry
  FARM_EARLY_EXIT_SECS: 120,    // Early exit: if held >= this AND pnl >= FARM_EARLY_EXIT_PNL
  FARM_EARLY_EXIT_PNL: 0.4,     // Early exit PnL threshold ($)
  FARM_EXTRA_WAIT_SECS: 30,     // Extra wait after hold expires if profitable (secs)

  // Hour blocking (UTC) — để trống = không block giờ nào
  // Ví dụ block giờ xấu: [7,8,9,10,11,18,19,20,21,22,23]
  // Dựa trên analytics: giờ tốt là 03:00–06:00 UTC và 13:00–16:00 UTC
  FARM_BLOCKED_HOURS: [] as number[],

  // ── Trade mode ────────────────────────────────────────────────────────────
  // Goal: maximize win rate. Only enter on strong signals. Exit on TP or SL only.
  // No time-based exit — let the trade run until TP or SL is hit.
  TRADE_TP_PERCENT: 0.003,      // Take profit 0.3% (~$210 at $70k BTC)
  TRADE_SL_PERCENT: 0.002,      // Stop loss 0.2% (~$140 at $70k BTC) → R:R = 1.5:1

  // ── Shared ────────────────────────────────────────────────────────────────
  // Trading fee: 0.012% maker per side, 0.024% round-trip
  FEE_RATE_MAKER: 0.00012,

  // Cooldown between trades
  COOLDOWN_MIN_MINS: 2,
  COOLDOWN_MAX_MINS: 10,

  // Skip closing positions below this USD value (avoids API "quantity invalid" errors)
  MIN_POSITION_VALUE_USD: 20,

  // Legacy — only used by PositionManager in trade mode trailing stop (not primary exit)
  MAX_POSITION: 0.05,
  STOP_LOSS_PERCENT: 0.05,
  TAKE_PROFIT_PERCENT: 0.05,
  POSITION_SL_PERCENT: 0.05,
  TIME_EXIT_SECONDS: 300,

  TELEGRAM_ENABLED: true
};
