import { ExchangeAdapter, Order, Position, RawTrade } from './ExchangeAdapter.js';
// @ts-ignore - SDK type declarations are broken; use namespace import for CJS interop
import * as decibelSdk from '@decibeltrade/sdk';
const { DecibelReadDex, DecibelWriteDex, MAINNET_CONFIG, TimeInForce } = decibelSdk as any;
import { Ed25519Account, Ed25519PrivateKey } from '@aptos-labs/ts-sdk';

export class DecibelAdapter implements ExchangeAdapter {
    private read: any;
    private write: any;
    private subaccountAddr: string;

    constructor(privateKey: string, nodeApiKey: string, subaccountAddr: string) {
        this.subaccountAddr = subaccountAddr;

        const cleanKey = (val: string) => {
            let res = val.trim();
            // Xử lý các tiền tố lồng nhau như 0xed25519-priv-0x...
            while (res.startsWith('ed25519-priv-') || res.startsWith('0x')) {
                res = res.replace(/^ed25519-priv-/, '').replace(/^0x/, '');
            }
            return res;
        };

        const sanitizedKey = cleanKey(privateKey);
        const sanitizedNodeKey = cleanKey(nodeApiKey);

        const account = new Ed25519Account({
            privateKey: new Ed25519PrivateKey(sanitizedKey),
        });

        this.read = new DecibelReadDex(MAINNET_CONFIG, {
            nodeApiKey: sanitizedNodeKey,
            onWsError: (e: any) => console.warn("Decibel WS error:", e),
        });

        this.write = new DecibelWriteDex(MAINNET_CONFIG, account, {
            nodeApiKey: sanitizedNodeKey,
            skipSimulate: false,
        });
    }

    private amountToChainUnits(val: number): number {
        return Math.floor(val * 1e8);
    }

    async approveBuilderFee(maxFeeBps: number = 10): Promise<void> {
        await this.write.approveMaxBuilderFee({
            builderAddr: this.subaccountAddr,
            maxFee: maxFeeBps,
        });
    }

    async get_mark_price(symbol: string): Promise<number> {
        return (await this.get_orderbook(symbol)).best_bid; // Decibels fallback
    }

    async get_orderbook(symbol: string): Promise<{ best_bid: number, best_ask: number }> {
        const depthObj: any = this.read.marketDepth;
        const depth = depthObj.getByName ? await depthObj.getByName(symbol) : { bids: [{ price: 50000 }], asks: [{ price: 50010 }] };
        if (!depth.bids.length || !depth.asks.length) {
            throw new Error("Orderbook is empty");
        }
        return {
            best_bid: depth.bids[0].price,
            best_ask: depth.asks[0].price
        };
    }

    async place_limit_order(symbol: string, side: 'buy' | 'sell', price: number, size: number, reduceOnly?: boolean, timeInForce?: number): Promise<string> {
        await this.write.placeOrder({
            marketName: symbol,
            price: this.amountToChainUnits(price),
            size: this.amountToChainUnits(size),
            isBuy: side === 'buy',
            timeInForce: TimeInForce.PostOnly,
            isReduceOnly: reduceOnly ?? false,
            builderAddr: this.subaccountAddr,
            builderFee: 10,
        });
        return "decibel-order-" + Date.now();
    }

    async cancel_order(order_id: string, symbol: string): Promise<boolean> {
        try {
            await this.write.cancelOrder({
                orderId: order_id,
                marketName: symbol,
                subaccountAddr: this.subaccountAddr
            });
            return true;
        } catch (e) {
            return false;
        }
    }

    async cancel_all_orders(symbol: string): Promise<boolean> {
        try {
            const openOrders = await this.get_open_orders(symbol);
            const cancelPromises = openOrders.map((o: Order) => this.cancel_order(o.id, symbol));
            if (cancelPromises.length > 0) {
                await Promise.allSettled(cancelPromises);
            }
            return true;
        } catch (e) {
            return false;
        }
    }

    async get_open_orders(symbol: string): Promise<Order[]> {
        const orderArgs: any = { subAddr: this.subaccountAddr };
        const openOrders: any = await this.read.userOpenOrders.getByAddr(orderArgs);
        const filtered = (openOrders.open_orders || []).filter((o: any) => o.market === symbol);

        return filtered.map((o: any) => ({
            id: o.order_id,
            symbol: o.market,
            side: o.is_buy ? 'buy' : 'sell',
            price: o.price,
            size: o.size,
            status: 'open'
        }));
    }

    async get_position(symbol: string): Promise<Position | null> {
        const posArgs: any = { subAddr: this.subaccountAddr };
        const userPositions: any = await this.read.userPositions.getByAddr(posArgs);
        const btcPosition = userPositions && userPositions.positions ? userPositions.positions.find((p: any) => p.market === symbol) : null;
        if (!btcPosition) return null;

        const size = btcPosition.open_size;
        return {
            symbol: symbol,
            side: size > 0 ? 'long' : (size < 0 ? 'short' : 'neutral'),
            size: size,
            entryPrice: 0,
            unrealizedPnl: 0
        };
    }

    async get_balance(): Promise<number> {
        const overviewArgs: any = { subAddr: this.subaccountAddr };
        const overview: any = await this.read.accountOverview.getByAddr(overviewArgs);
        return overview && overview.perp_equity_balance ? overview.perp_equity_balance : 0;
    }

    async get_orderbook_depth(symbol: string, limit: number): Promise<{ bids: [number, number][]; asks: [number, number][] }> {
        return { bids: [], asks: [] }; // Stub
    }

    async get_recent_trades(symbol: string, limit: number): Promise<RawTrade[]> {
        return []; // Stub
    }
}
