import { Position } from '../adapters/ExchangeAdapter.js';
import { config } from '../config.js';

export class RiskManager {
    shouldClose(currentPrice: number, position: Position): boolean {
        const { side, entryPrice, unrealizedPnl } = position;

        if (config.MODE === 'farm') {
            // Farm mode: SL 5% hard stop
            const sl = side === 'long'
                ? entryPrice * (1 - config.FARM_SL_PERCENT)
                : entryPrice * (1 + config.FARM_SL_PERCENT);

            if (side === 'long' && currentPrice <= sl) {
                console.log(`🛑 [FARM SL] Stop Loss triggered at ${currentPrice} (SL: ${sl.toFixed(2)})`);
                return true;
            }
            if (side === 'short' && currentPrice >= sl) {
                console.log(`🛑 [FARM SL] Stop Loss triggered at ${currentPrice} (SL: ${sl.toFixed(2)})`);
                return true;
            }
        } else {
            // Trade mode: SL 10%
            const sl = side === 'long'
                ? entryPrice * (1 - config.TRADE_SL_PERCENT)
                : entryPrice * (1 + config.TRADE_SL_PERCENT);
            const tp = side === 'long'
                ? entryPrice * (1 + config.TRADE_TP_PERCENT)
                : entryPrice * (1 - config.TRADE_TP_PERCENT);

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
