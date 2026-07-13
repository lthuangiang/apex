import { ExchangeAdapter, Position } from '../adapters/ExchangeAdapter.js';
import { TelegramManager } from './TelegramManager.js';
import { ExecutionEdge } from './ExecutionEdge.js';

export interface PendingOrder {
    orderId: string;
    price: number;
    size: number;
}

export class Executor {
    constructor(
        private adapter: ExchangeAdapter,
        private telegram: TelegramManager,
        private executionEdge?: ExecutionEdge,
    ) { }

    /**
     * Price decimals (tick precision) for `symbol`. Uses the adapter's real value
     * when available; falls back to 2 decimals for adapters that don't expose it.
     */
    private async getPriceDecimals(symbol: string): Promise<number> {
        if (this.adapter.get_price_decimals) {
            try {
                return await this.adapter.get_price_decimals(symbol);
            } catch {
                // fall through to default
            }
        }
        return 2;
    }

    /**
     * Places a Post-Only entry order. Returns order info immediately — does NOT wait for fill.
     * Watcher will check fill status on the next tick.
     */
    async placeEntryOrder(
        symbol: string,
        direction: 'long' | 'short',
        size: number,
        priceOffset = 0, // positive = move price away from spread to ensure Post-Only
        aggressive = false, // true = cross spread for immediate fill (FARM mode)
    ): Promise<PendingOrder | null> {
        try {
            const ob = await this.adapter.get_orderbook(symbol);

            let price: number;
            const side = direction === 'long' ? 'buy' : 'sell';

            if (aggressive) {
                // Taker: cross the spread for immediate fill
                price = direction === 'long' ? ob.best_ask : ob.best_bid;
                console.log(`[Executor] Placing ${direction.toUpperCase()} entry order: ${size} ${symbol} @ ${price} (IOC/taker)...`);
                const orderId = await this.adapter.place_limit_order(symbol, side, price, size, false, 1);
                console.log(`[Executor] Entry order placed: ${orderId}`);
                await this.telegram.sendMessage(
                    `📋 *Entry order placed*\n• Symbol: \`${symbol}\`\n• Direction: \`${direction.toUpperCase()}\`\n• Size: \`${size.toFixed(5)}\`\n• Price: \`${price}\` (IOC/taker)`
                );
                return { orderId, price, size };
            }

            // Task 4.2–4.4: Use ExecutionEdge for dynamic offset if available
            let effectiveOffset: number;
            if (symbol == "SPCX-USD") {
                effectiveOffset = 0.01
            } else {
                    if (this.executionEdge) {
                    const edgeResult = await this.executionEdge.computeOffset(symbol, direction, ob);
                    // Task 4.3: Return null when spread is too wide
                    if (!edgeResult.spreadOk) {
                        console.warn(
                            `[Executor] Spread too wide (${edgeResult.spreadBps.toFixed(1)} bps). Skipping entry.`
                        );
                        return null;
                    }
                    // Task 4.4: Use edge offset
                    effectiveOffset = edgeResult.offset;
                } else {
                    // Task 4.5: Legacy fallback
                    effectiveOffset = priceOffset;
                }
            }
            effectiveOffset = 0.001

            // Post-Only (maker): Buy @ best_bid - offset, Sell @ best_ask + offset.
            // Round to the market's real tick. Flooring to 2 decimals on a 3-decimal
            // tick (e.g. SOL, tick 0.001) truncates the price up to 0.009 behind the
            // touch, so the order rests too far back and never fills.
            // The +/- 1e-9 nudge absorbs float error so we land exactly on the tick.
            const factor = Math.pow(10, await this.getPriceDecimals(symbol));
            const rawPrice = direction === 'long' ? ob.best_bid : ob.best_ask;
            price = direction === 'long'
                ? Math.floor((rawPrice - effectiveOffset) * factor + 1e-9) / factor
                : Math.ceil((rawPrice + effectiveOffset) * factor - 1e-9) / factor;

            console.log(`[Executor] Placing ${direction.toUpperCase()} entry order: ${size} ${symbol} @ ${price} (Post-Only)...`);
            const orderId = await this.adapter.place_limit_order(symbol, side, price, size);
            console.log(`[Executor] Entry order placed: ${orderId}`);

            await this.telegram.sendMessage(
                `📋 *Entry order placed*\n• Symbol: \`${symbol}\`\n• Direction: \`${direction.toUpperCase()}\`\n• Size: \`${size.toFixed(5)}\`\n• Price: \`${price}\` (Post-Only)`
            );

            return { orderId, price, size };
        } catch (error) {
            console.error('[Executor] Error placing entry order:', error);
            return null;
        }
    }

    /**
     * Places a Post-Only exit order. Returns order info immediately — does NOT wait for fill.
     * Use forceClose=true for IOC (cross spread) to guarantee fill.
     */
    async placeExitOrder(
        symbol: string,
        position: Position,
        forceClose = false,
    ): Promise<PendingOrder | null> {
        try {
            const { side, size } = position;
            const ob = await this.adapter.get_orderbook(symbol);
            const exitSide = side === 'long' ? 'sell' : 'buy';

            let price: number;
            let timeInForce: number;
            let label: string;

            if (forceClose) {
                // IOC: cross spread for guaranteed fill
                // Long exit (sell) → hit best_bid; Short exit (buy) → hit best_ask
                price = side === 'long' ? ob.best_bid : ob.best_ask;
                timeInForce = 3;
                label = 'IOC/taker';
            } else {
                // Post-Only: join book as maker
                price = side === 'long' ? ob.best_ask : ob.best_bid;
                timeInForce = 4;
                label = 'Post-Only/maker';
            }

            // Note: caller (Watcher) is responsible for cancelling open orders before calling this
            console.log(`[Executor] Placing ${side.toUpperCase()} exit order: ${Math.abs(size)} ${symbol} @ ${price} (${label})...`);
            const orderId = await this.adapter.place_limit_order(symbol, exitSide, price, Math.abs(size), true, timeInForce);
            console.log(`[Executor] Exit order placed: ${orderId}`);

            await this.telegram.sendMessage(
                `📋 *Exit order placed*\n• Symbol: \`${symbol}\`\n• Side: \`${side.toUpperCase()}\`\n• Size: \`${Math.abs(size).toFixed(5)}\`\n• Price: \`${price}\` (${label})`
            );

            return { orderId, price, size: Math.abs(size) };
        } catch (error) {
            console.error('[Executor] Error placing exit order:', error);
            return null;
        }
    }

    /**
     * Sends Telegram notification when an entry order is confirmed filled.
     */
    async notifyEntryFilled(
        symbol: string,
        direction: 'long' | 'short',
        filledSize: number,
        price: number,
        meta?: { baseScore: number; bias: number; regime: string; finalScore: number; sessionPnl: number; sessionVolume: number; reasoning: string; fallback: boolean }
    ): Promise<void> {
        const vol = filledSize * price;
        let msg = `✅ *ENTRY FILLED — ${direction.toUpperCase()}*\n` +
                  `• Symbol: \`${symbol}\`\n` +
                  `• Size: \`${filledSize.toFixed(5)}\` (~${vol.toFixed(2)} USDC)\n` +
                  `• Price: \`${price}\`\n`;
        if (meta) {
            msg += `\n🧠 *Decision Engine*\n` +
                   `• Regime: \`${meta.regime}\`\n` +
                   `• Base Score: \`${meta.baseScore.toFixed(2)}\`\n` +
                   `• Bias: \`${(meta.bias > 0 ? '+' : '')}${meta.bias.toFixed(2)}\`\n` +
                   `• Final Score: \`${meta.finalScore.toFixed(2)}\`\n` +
                   `\n💰 *Session PnL: ${meta.sessionPnl.toFixed(2)}*\n` +
                   `📈 *Session Volume: ${meta.sessionVolume.toFixed(2)}*`;
            if (meta.fallback) {
                msg += `\n🔄 *[Fallback Mode]*`;
            } else {
                msg += `\n💬 *Reasoning:* \`${meta.reasoning.slice(0, 200)}\``;
            }
        }
        await this.telegram.sendMessage(msg);
    }

    /**
     * Sends Telegram notification when an exit order is confirmed filled.
     */
    async notifyExitFilled(
        symbol: string,
        side: 'long' | 'short',
        filledSize: number,
        price: number,
        pnl: number,
        meta?: { sessionPnl: number; sessionVolume: number; reasoning: string; fallback: boolean }
    ): Promise<void> {
        const vol = filledSize * price;
        let msg = `✅ *EXIT FILLED — ${side.toUpperCase()}*\n` +
                  `• Symbol: \`${symbol}\`\n` +
                  `• Size: \`${filledSize.toFixed(5)}\` (~${vol.toFixed(2)} USDC)\n` +
                  `• Price: \`${price}\`\n` +
                  `• PnL: \`${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}\``;
        if (meta) {
            msg += `\n\n💰 *Session PnL: ${meta.sessionPnl.toFixed(2)}*\n` +
                   `📈 *Session Volume: ${meta.sessionVolume.toFixed(2)}*`;
            if (meta.fallback) {
                msg += `\n🔄 *[Fallback Mode]*`;
            } else {
                msg += `\n💬 *Reasoning:* \`${meta.reasoning.slice(0, 200)}\``;
            }
        }
        await this.telegram.sendMessage(msg);
    }

    async cancelAll(symbol: string) {
        return this.adapter.cancel_all_orders(symbol);
    }
}
