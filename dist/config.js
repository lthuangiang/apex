"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
exports.config = {
    MODE: "farm", // 'farm' (no skip, max volume) or 'trade' (skip neutral, max profit)
    // Adapter configuration
    EXCHANGE: "sodex", // 'sodex' or 'decibel'
    // Core parameters
    MARKET: "BTC-USD",
    SYMBOL: "BTC-USD",
    // Order sizing
    ORDER_SIZE_MIN: 0.003,
    ORDER_SIZE_MAX: 0.005,
    // Risk management
    MAX_POSITION: 0.05,
    STOP_LOSS_PERCENT: 0.05,
    TAKE_PROFIT_PERCENT: 0.05,
    POSITION_SL_PERCENT: 0.05,
    TIME_EXIT_SECONDS: 180,
    // Signal filtering
    SIGNAL_THRESHOLD: 1.2,
    MIN_CONFIDENCE: 0.65, // Only enter when confidence > 65% (was 0.5 — too loose)
    NEUTRAL_ZONE: [0.45, 0.55],
    // Chart signal — 15m/50 candles for reliable contrarian SMA (was 5m/10 — too noisy)
    CHART_INTERVAL: '15m',
    CHART_LIMIT: 50,
    // Farm mode exit rules
    FARM_MIN_HOLD_SECS: 120, // Minimum hold 2 mins after entry fill
    FARM_MAX_HOLD_SECS: 600, // Maximum hold 10 mins
    FARM_TP_USD: 1.0, // Take profit when PnL > $1
    FARM_SL_PERCENT: 0.05, // Stop loss 5%
    // Trade mode exit rules
    TRADE_TP_PERCENT: 0.10, // Take profit 10%
    TRADE_SL_PERCENT: 0.10, // Stop loss 10%
    // Cooldown after each trade — min 5 mins to let market reset (was 2 mins)
    COOLDOWN_MIN_MINS: 2,
    COOLDOWN_MAX_MINS: 10,
    TELEGRAM_ENABLED: true
};
