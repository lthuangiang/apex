export const config = {
  MODE: "farm", // 'farm' (volume farming, 2-5 min scalps) or 'trade' (signal-filtered, TP/SL based)

  // Exchange
  EXCHANGE: "sodex", // 'sodex', 'decibel', or 'dango'
  MARKET: "BTC-USD",
  SYMBOL: "BTC-USD",

  // Order sizing (BTC)
  ORDER_SIZE_MIN: 0.003,
  ORDER_SIZE_MAX: 0.005,

  // Dynamic position sizing
  SIZING_MIN_MULTIPLIER: 0.5,
  SIZING_MAX_MULTIPLIER: 2.0,
  SIZING_CONF_WEIGHT: 0.6,
  SIZING_PERF_WEIGHT: 0.4,
  SIZING_DRAWDOWN_THRESHOLD: -3.0,
  SIZING_DRAWDOWN_FLOOR: 0.5,
  SIZING_MAX_BTC: 0.008,
  SIZING_MAX_BALANCE_PCT: 0.02,

  // Signal filtering (trade mode only)
  MIN_CONFIDENCE: 0.65,
  NEUTRAL_ZONE: [0.45, 0.55],
  SIGNAL_THRESHOLD: 1.2,

  // Chart data — 5m candles for short-term momentum
  CHART_INTERVAL: '5m',
  CHART_LIMIT: 30,

  // ── Farm mode ─────────────────────────────────────────────────────────────
  // Goal: maximize volume. Enter frequently, hold short, exit when profitable.
  FARM_MIN_HOLD_SECS: 60,       // Hold at least 60s after fill (reduced from 120s)
  FARM_MAX_HOLD_SECS: 180,      // Force exit after 3 mins (reduced from 5 mins)
  FARM_TP_USD: 0.5,             // TP $0.5 — đủ cover fee với size nhỏ (fee ~$0.07 per trade)
  FARM_SL_PERCENT: 0.05,        // Stop loss 5% — rộng để không bị stop out sớm
  FARM_SCORE_EDGE: 0.03,        // Min score edge to enter (|score - 0.5| > this)
  FARM_MIN_CONFIDENCE: 0.50,    // Min confidence for fallback signal entry
  FARM_EARLY_EXIT_SECS: 60,     // Early exit: if held >= 60s AND pnl >= FARM_EARLY_EXIT_PNL
  FARM_EARLY_EXIT_PNL: 0.3,     // Early exit PnL threshold ($0.3 — covers round-trip fee)
  FARM_EXTRA_WAIT_SECS: 15,     // Extra wait after hold expires if profitable (reduced from 30s)

  // ── Regime-adaptive strategy ──────────────────────────────────────────────
  REGIME_ATR_PERIOD: 14,
  REGIME_BB_PERIOD: 20,
  REGIME_BB_STD_DEV: 2,
  REGIME_VOL_LOOKBACK: 10,
  REGIME_HIGH_VOL_THRESHOLD: 0.005,
  REGIME_TREND_EMA_BAND: 0.002,
  REGIME_BB_TREND_MIN: 0.01,
  REGIME_TREND_HOLD_MULT: 1.5,
  REGIME_SIDEWAY_HOLD_MULT: 0.8,
  REGIME_HIGH_VOL_HOLD_MULT: 0.7,
  REGIME_HIGH_VOL_SIZE_FACTOR: 0.5,
  REGIME_SIDEWAY_SIZE_FACTOR: 0.85,
  REGIME_HIGH_VOL_SL_MULT: 1.5,
  REGIME_HIGH_VOL_SKIP_ENTRY: false,
  REGIME_TREND_SUPPRESS_EARLY_EXIT: true,

  // Hour blocking (UTC) — để trống = không block giờ nào
  // Ví dụ block giờ xấu: [7,8,9,10,11,18,19,20,21,22,23]
  // Dựa trên analytics: giờ tốt là 03:00–06:00 UTC và 13:00–16:00 UTC
  FARM_BLOCKED_HOURS: [] as number[],

  // ── Trade mode ────────────────────────────────────────────────────────────
  // Goal: maximize win rate. Only enter on strong signals. Exit on TP or SL only.
  // No time-based exit — let the trade run until TP or SL is hit.
  TRADE_TP_PERCENT: 0.05,      // Take profit 5%
  TRADE_SL_PERCENT: 0.05,      // Stop loss 5%

  // ── Shared ────────────────────────────────────────────────────────────────
  // Trading fee: 0.012% maker per side, 0.024% round-trip
  FEE_RATE_MAKER: 0.00012,

  // Cooldown between trades (trade mode only — farm mode uses FARM_COOLDOWN_SECS)
  COOLDOWN_MIN_MINS: 2,
  COOLDOWN_MAX_MINS: 4,

  // Farm mode uses a short fixed cooldown (ignores adaptive multipliers)
  FARM_COOLDOWN_SECS: 30,       // Fixed 30s cooldown after each farm trade

  // Skip closing positions below this USD value (avoids API "quantity invalid" errors)
  MIN_POSITION_VALUE_USD: 20,

  // Legacy — only used by PositionManager in trade mode trailing stop (not primary exit)
  MAX_POSITION: 0.05,
  STOP_LOSS_PERCENT: 0.05,
  TAKE_PROFIT_PERCENT: 0.05,
  POSITION_SL_PERCENT: 0.05,
  TIME_EXIT_SECONDS: 300,

  TELEGRAM_ENABLED: true,

  // ── Anti-Chop & Trade Filtering (Phase 4) ────────────────────────────────────

  // Chop detection
  CHOP_FLIP_WINDOW: 5,                       // number of recent signals to check for direction flips
  CHOP_FLIP_WEIGHT: 0.4,                     // weight of flip rate in chop score
  CHOP_MOM_WEIGHT: 0.35,                     // weight of momentum neutrality in chop score
  CHOP_BB_WEIGHT: 0.25,                      // weight of BB compression in chop score
  CHOP_BB_COMPRESS_MAX: 0.015,               // bbWidth below this = maximum compression (score = 1.0)
  CHOP_SCORE_THRESHOLD: 0.55,                // chopScore >= this → isChoppy = true, skip entry

  // Fake breakout filter
  CHOP_BREAKOUT_SCORE_EDGE: 0.15,           // |score - 0.5| > this = "breakout attempt" (raised from 0.08 — farm mode enters on moderate signals)
  CHOP_BREAKOUT_VOL_MIN: 0.4,              // volRatio below this = insufficient volume (lowered from 0.8 — low volume is normal in off-peak hours)
  CHOP_BREAKOUT_IMBALANCE_THRESHOLD: 0.15,  // |imbalance| above this = orderbook contradicts direction

  // Adaptive cooldown
  CHOP_COOLDOWN_STREAK_FACTOR: 0.5,         // each losing trade adds 50% to cooldown multiplier
  CHOP_COOLDOWN_CHOP_FACTOR: 1.0,           // chopScore=1.0 doubles the cooldown
  CHOP_COOLDOWN_MAX_MINS: 30,               // hard ceiling on adaptive cooldown (mins)

  // ── Farm Market Making (Phase 6) ─────────────────────────────────────────
  MM_ENABLED: true,                    // enable pseudo market-making in FARM mode
  MM_PINGPONG_BIAS_STRENGTH: 0.08,     // score delta added toward opposite side after exit
  MM_INVENTORY_SOFT_BIAS: 50,          // net USD exposure above which soft bias activates
  MM_INVENTORY_HARD_BLOCK: 150,        // net USD exposure above which entry is hard-blocked
  MM_INVENTORY_BIAS_STRENGTH: 0.12,    // score delta applied when soft bias is active
  MM_SPREAD_MULT: 1.5,                 // profit_target = spreadBps × MM_SPREAD_MULT × price / 10000
  MM_MIN_FEE_MULT: 1.5,                // floor: profit_target >= feeRoundTrip × this
  MM_TP_MAX_USD: 2.0,                  // ceiling on dynamic TP (USD)

  // ── Execution Edge (Phase 5) ──────────────────────────────────────────────

  // Spread guard
  EXEC_MAX_SPREAD_BPS: 10,          // skip entry if spread > this (basis points)

  // Dynamic offset formula
  EXEC_SPREAD_OFFSET_MULT: 0.3,     // offset += spreadBps × this (USD per bps)
  EXEC_DEPTH_LEVELS: 5,             // number of orderbook levels to sum for depth score
  EXEC_DEPTH_THIN_THRESHOLD: 50000, // depth (USD) below which thin-book penalty applies
  EXEC_DEPTH_PENALTY: 0.5,          // extra offset (USD) added when book is thin

  // Fill rate feedback
  EXEC_FILL_WINDOW: 20,             // ring buffer size (number of recent orders)
  EXEC_FILL_RATE_THRESHOLD: 0.6,    // fill rate below this triggers penalty
  EXEC_FILL_RATE_PENALTY: 1.0,      // extra offset (USD) added when fill rate is low

  // Offset bounds
  EXEC_OFFSET_MIN: 0,               // minimum offset (USD) — 0 = no floor
  EXEC_OFFSET_MAX: 5,               // maximum offset (USD) — hard ceiling
};
