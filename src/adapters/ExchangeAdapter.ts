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
    /** Accumulated funding payment (positive = received, negative = paid). Optional. */
    funding?: number;
}

export interface RawTrade {
    side: 'buy' | 'sell';
    price: number;
    size: number;
    timestamp: number;
}

export interface Kline {
    t: number; // open timestamp (ms)
    o: number; // open
    h: number; // high
    l: number; // low
    c: number; // close
    v: number; // volume
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
    /** Fetch OHLCV klines. Returns candles in chronological order (oldest first). */
    get_klines?(symbol: string, interval: string, limit: number): Promise<Kline[]>;
    /**
     * Fetch the list of tradeable market symbols from the exchange.
     * Returns symbol names in the format the exchange expects (e.g. "BTC/USD" for Decibel,
     * "BTC-USD" for SoDEX/Dango). Used by the Create Bot wizard to populate the symbol picker.
     * Optional — falls back to `supportedSymbols` static list if not implemented.
     */
    get_markets?(): Promise<string[]>;
    /**
     * Number of decimal places allowed in an order price for `symbol`
     * (e.g. 3 → tick 0.001). Used to round maker prices to a valid tick so
     * Post-Only orders rest at the touch instead of behind it. Optional —
     * callers fall back to 2 decimals when not implemented.
     */
    get_price_decimals?(symbol: string): Promise<number>;
    /**
     * Fetch the current funding rate for `symbol`.
     * Returns the hourly (or per-interval) funding rate as a decimal
     * (e.g. 0.0001 = 0.01%), or null if not available.
     * Optional — callers should handle null gracefully.
     */
    get_funding_rate?(symbol: string): Promise<number | null>;
}
