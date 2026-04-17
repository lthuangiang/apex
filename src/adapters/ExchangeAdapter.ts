export interface Order {
    id: string;
    symbol: string;
    side: 'buy' | 'sell';
    price: number;
    size: number;
    status: string;
}

export interface Position {
    symbol: string;
    side: 'long' | 'short' | 'neutral';
    size: number;
    entryPrice: number;
    unrealizedPnl: number;
}

export interface RawTrade {
    side: 'buy' | 'sell';
    price: number;
    size: number;
    timestamp: number;
}

export interface ExchangeAdapter {
    get_mark_price(symbol: string): Promise<number>;
    get_orderbook(symbol: string): Promise<{ best_bid: number, best_ask: number }>;
    place_limit_order(symbol: string, side: 'buy' | 'sell', price: number, size: number, reduceOnly?: boolean, timeInForce?: number): Promise<string>;
    cancel_order(order_id: string, symbol: string): Promise<boolean>;
    cancel_all_orders(symbol: string): Promise<boolean>;
    get_open_orders(symbol: string): Promise<Order[]>;
    /**
     * Returns the current open position for `symbol`, or null if flat.
     * `markPrice` is provided so adapters that don't receive unrealized PnL
     * from their API (e.g. Decibel) can compute it locally without an extra
     * round-trip. Adapters that already receive PnL from the API may ignore it.
     */
    get_position(symbol: string, markPrice?: number): Promise<Position | null>;
    get_balance(): Promise<number>;
    get_orderbook_depth(symbol: string, limit: number): Promise<{ bids: [number, number][], asks: [number, number][] }>;
    get_recent_trades(symbol: string, limit: number): Promise<RawTrade[]>;
}
