"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RiskManager = void 0;
const config_js_1 = require("../config.js");
class RiskManager {
    shouldClose(currentPrice, position) {
        const { side, entryPrice, unrealizedPnl } = position;
        if (config_js_1.config.MODE === 'farm') {
            // Farm mode: SL 5% hard stop
            const sl = side === 'long'
                ? entryPrice * (1 - config_js_1.config.FARM_SL_PERCENT)
                : entryPrice * (1 + config_js_1.config.FARM_SL_PERCENT);
            if (side === 'long' && currentPrice <= sl) {
                console.log(`🛑 [FARM SL] Stop Loss triggered at ${currentPrice} (SL: ${sl.toFixed(2)})`);
                return true;
            }
            if (side === 'short' && currentPrice >= sl) {
                console.log(`🛑 [FARM SL] Stop Loss triggered at ${currentPrice} (SL: ${sl.toFixed(2)})`);
                return true;
            }
        }
        else {
            // Trade mode: SL 10%
            const sl = side === 'long'
                ? entryPrice * (1 - config_js_1.config.TRADE_SL_PERCENT)
                : entryPrice * (1 + config_js_1.config.TRADE_SL_PERCENT);
            const tp = side === 'long'
                ? entryPrice * (1 + config_js_1.config.TRADE_TP_PERCENT)
                : entryPrice * (1 - config_js_1.config.TRADE_TP_PERCENT);
            if (side === 'long' && currentPrice <= sl) {
                console.log(`🛑 [TRADE SL] Stop Loss triggered at ${currentPrice} (SL: ${sl.toFixed(2)})`);
                return true;
            }
            if (side === 'short' && currentPrice >= sl) {
                console.log(`🛑 [TRADE SL] Stop Loss triggered at ${currentPrice} (SL: ${sl.toFixed(2)})`);
                return true;
            }
            if (side === 'long' && currentPrice >= tp) {
                console.log(`✅ [TRADE TP] Take Profit triggered at ${currentPrice} (TP: ${tp.toFixed(2)})`);
                return true;
            }
            if (side === 'short' && currentPrice <= tp) {
                console.log(`✅ [TRADE TP] Take Profit triggered at ${currentPrice} (TP: ${tp.toFixed(2)})`);
                return true;
            }
        }
        return false;
    }
}
exports.RiskManager = RiskManager;
