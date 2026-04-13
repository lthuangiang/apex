"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Executor = void 0;
class Executor {
    adapter;
    telegram;
    constructor(adapter, telegram) {
        this.adapter = adapter;
        this.telegram = telegram;
    }
    /**
     * Places a Post-Only entry order. Returns order info immediately — does NOT wait for fill.
     * Watcher will check fill status on the next tick.
     */
    async placeEntryOrder(symbol, direction, size, priceOffset = 0) {
        try {
            const ob = await this.adapter.get_orderbook(symbol);
            // Post-Only (maker): Buy @ best_bid - offset, Sell @ best_ask + offset
            // Offset ensures order sits inside book and won't cross spread on re-place
            const rawPrice = direction === 'long' ? ob.best_bid : ob.best_ask;
            const price = direction === 'long'
                ? Math.floor((rawPrice - priceOffset) * 100) / 100
                : Math.ceil((rawPrice + priceOffset) * 100) / 100;
            const side = direction === 'long' ? 'buy' : 'sell';
            // Note: caller (Watcher) is responsible for cancelling open orders before calling this
            console.log(`[Executor] Placing ${direction.toUpperCase()} entry order: ${size} ${symbol} @ ${price} (Post-Only)...`);
            const orderId = await this.adapter.place_limit_order(symbol, side, price, size);
            console.log(`[Executor] Entry order placed: ${orderId}`);
            await this.telegram.sendMessage(`📋 *Entry order placed*\n• Symbol: \`${symbol}\`\n• Direction: \`${direction.toUpperCase()}\`\n• Size: \`${size.toFixed(5)}\`\n• Price: \`${price}\` (Post-Only)`);
            return { orderId, price, size };
        }
        catch (error) {
            console.error('[Executor] Error placing entry order:', error);
            return null;
        }
    }
    /**
     * Places a Post-Only exit order. Returns order info immediately — does NOT wait for fill.
     * Use forceClose=true for IOC (cross spread) to guarantee fill.
     */
    async placeExitOrder(symbol, position, forceClose = false) {
        try {
            const { side, size } = position;
            const ob = await this.adapter.get_orderbook(symbol);
            const exitSide = side === 'long' ? 'sell' : 'buy';
            let price;
            let timeInForce;
            let label;
            if (forceClose) {
                // IOC: cross spread for guaranteed fill
                price = side === 'long' ? ob.best_bid : ob.best_ask;
                timeInForce = 3;
                label = 'IOC/taker';
            }
            else {
                // Post-Only: join book as maker
                price = side === 'long' ? ob.best_ask : ob.best_bid;
                timeInForce = 4;
                label = 'Post-Only/maker';
            }
            // Note: caller (Watcher) is responsible for cancelling open orders before calling this
            console.log(`[Executor] Placing ${side.toUpperCase()} exit order: ${Math.abs(size)} ${symbol} @ ${price} (${label})...`);
            const orderId = await this.adapter.place_limit_order(symbol, exitSide, price, Math.abs(size), true, timeInForce);
            console.log(`[Executor] Exit order placed: ${orderId}`);
            await this.telegram.sendMessage(`📋 *Exit order placed*\n• Symbol: \`${symbol}\`\n• Side: \`${side.toUpperCase()}\`\n• Size: \`${Math.abs(size).toFixed(5)}\`\n• Price: \`${price}\` (${label})`);
            return { orderId, price, size: Math.abs(size) };
        }
        catch (error) {
            console.error('[Executor] Error placing exit order:', error);
            return null;
        }
    }
    /**
     * Sends Telegram notification when an entry order is confirmed filled.
     */
    async notifyEntryFilled(symbol, direction, filledSize, price, meta) {
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
            }
            else {
                msg += `\n💬 *Reasoning:* \`${meta.reasoning.slice(0, 200)}\``;
            }
        }
        await this.telegram.sendMessage(msg);
    }
    /**
     * Sends Telegram notification when an exit order is confirmed filled.
     */
    async notifyExitFilled(symbol, side, filledSize, price, pnl, meta) {
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
            }
            else {
                msg += `\n💬 *Reasoning:* \`${meta.reasoning.slice(0, 200)}\``;
            }
        }
        await this.telegram.sendMessage(msg);
    }
    async cancelAll(symbol) {
        return this.adapter.cancel_all_orders(symbol);
    }
}
exports.Executor = Executor;
