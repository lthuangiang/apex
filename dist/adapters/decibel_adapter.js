"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DecibelAdapter = void 0;
// @ts-ignore - SDK type declarations are broken; use namespace import for CJS interop
const decibelSdk = __importStar(require("@decibeltrade/sdk"));
const { DecibelReadDex, DecibelWriteDex, MAINNET_CONFIG, TimeInForce } = decibelSdk;
const ts_sdk_1 = require("@aptos-labs/ts-sdk");
class DecibelAdapter {
    read;
    write;
    subaccountAddr;
    constructor(privateKey, nodeApiKey, subaccountAddr) {
        this.subaccountAddr = subaccountAddr;
        const cleanKey = (val) => {
            let res = val.trim();
            // Xử lý các tiền tố lồng nhau như 0xed25519-priv-0x...
            while (res.startsWith('ed25519-priv-') || res.startsWith('0x')) {
                res = res.replace(/^ed25519-priv-/, '').replace(/^0x/, '');
            }
            return res;
        };
        const sanitizedKey = cleanKey(privateKey);
        const sanitizedNodeKey = cleanKey(nodeApiKey);
        const account = new ts_sdk_1.Ed25519Account({
            privateKey: new ts_sdk_1.Ed25519PrivateKey(sanitizedKey),
        });
        this.read = new DecibelReadDex(MAINNET_CONFIG, {
            nodeApiKey: sanitizedNodeKey,
            onWsError: (e) => console.warn("Decibel WS error:", e),
        });
        this.write = new DecibelWriteDex(MAINNET_CONFIG, account, {
            nodeApiKey: sanitizedNodeKey,
            skipSimulate: false,
        });
    }
    amountToChainUnits(val) {
        return Math.floor(val * 1e8);
    }
    async get_mark_price(symbol) {
        return (await this.get_orderbook(symbol)).best_bid; // Decibels fallback
    }
    async get_orderbook(symbol) {
        const depthObj = this.read.marketDepth;
        const depth = depthObj.getByName ? await depthObj.getByName(symbol) : { bids: [{ price: 50000 }], asks: [{ price: 50010 }] };
        if (!depth.bids.length || !depth.asks.length) {
            throw new Error("Orderbook is empty");
        }
        return {
            best_bid: depth.bids[0].price,
            best_ask: depth.asks[0].price
        };
    }
    async place_limit_order(symbol, side, price, size) {
        await this.write.placeOrder({
            marketName: symbol,
            price: this.amountToChainUnits(price),
            size: this.amountToChainUnits(size),
            isBuy: side === 'buy',
            timeInForce: TimeInForce.PostOnly,
            isReduceOnly: false,
            builderAddr: this.subaccountAddr
        });
        return "decibel-order-" + Date.now();
    }
    async cancel_order(order_id, symbol) {
        try {
            await this.write.cancelOrder({
                orderId: order_id,
                marketName: symbol,
                subaccountAddr: this.subaccountAddr
            });
            return true;
        }
        catch (e) {
            return false;
        }
    }
    async cancel_all_orders(symbol) {
        try {
            const openOrders = await this.get_open_orders(symbol);
            const cancelPromises = openOrders.map((o) => this.cancel_order(o.id, symbol));
            if (cancelPromises.length > 0) {
                await Promise.allSettled(cancelPromises);
            }
            return true;
        }
        catch (e) {
            return false;
        }
    }
    async get_open_orders(symbol) {
        const orderArgs = { subAddr: this.subaccountAddr };
        const openOrders = await this.read.userOpenOrders.getByAddr(orderArgs);
        const filtered = (openOrders.open_orders || []).filter((o) => o.market === symbol);
        return filtered.map((o) => ({
            id: o.order_id,
            symbol: o.market,
            side: o.is_buy ? 'buy' : 'sell',
            price: o.price,
            size: o.size,
            status: 'open'
        }));
    }
    async get_position(symbol) {
        const posArgs = { subAddr: this.subaccountAddr };
        const userPositions = await this.read.userPositions.getByAddr(posArgs);
        const btcPosition = userPositions && userPositions.positions ? userPositions.positions.find((p) => p.market === symbol) : null;
        if (!btcPosition)
            return null;
        const size = btcPosition.open_size;
        return {
            symbol: symbol,
            side: size > 0 ? 'long' : (size < 0 ? 'short' : 'neutral'),
            size: size,
            entryPrice: 0,
            unrealizedPnl: 0
        };
    }
    async get_balance() {
        const overviewArgs = { subAddr: this.subaccountAddr };
        const overview = await this.read.accountOverview.getByAddr(overviewArgs);
        return overview && overview.perp_equity_balance ? overview.perp_equity_balance : 0;
    }
    async get_orderbook_depth(symbol, limit) {
        return { bids: [], asks: [] }; // Stub
    }
    async get_recent_trades(symbol, limit) {
        return []; // Stub
    }
}
exports.DecibelAdapter = DecibelAdapter;
