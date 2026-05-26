import { Position } from '../adapters/ExchangeAdapter.js';

export interface RiskPolicy {
    mode: 'farm' | 'trade';
    farmSlPercent: number;
    tradeSlPercent: number;
    tradeTpPercent: number;
}

export class RiskManager {
    shouldClose(currentPrice: number, position: Position, policy: RiskPolicy): boolean {
        const { side, entryPrice } = position;

        if (policy.mode === 'farm') {
            const slPercent = policy.farmSlPercent;
            const sl = side === 'long'
                ? entryPrice * (1 - slPercent)
                : entryPrice * (1 + slPercent);

            if (side === 'long' && currentPrice <= sl) {
                console.log(`🛑 [FARM SL] Stop Loss triggered at ${currentPrice} (SL: ${sl.toFixed(2)})`);
                return true;
            }
            if (side === 'short' && currentPrice >= sl) {
                console.log(`🛑 [FARM SL] Stop Loss triggered at ${currentPrice} (SL: ${sl.toFixed(2)})`);
                return true;
            }
        } else {
            const sl = side === 'long'
                ? entryPrice * (1 - policy.tradeSlPercent)
                : entryPrice * (1 + policy.tradeSlPercent);
            const tp = side === 'long'
                ? entryPrice * (1 + policy.tradeTpPercent)
                : entryPrice * (1 - policy.tradeTpPercent);

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
