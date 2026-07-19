// OndoPerps API Types
// Based on https://docs.ondoperps.xyz/api-reference

export interface OndoPerpsConfig {
  apiKeyId: string;      // "ondoKeyId_..." prefix
  apiKeySecret: string;  // "ondoApiSecret_..." prefix
  baseUrl?: string;      // defaults to https://api.ondoperps.xyz
}

// ── API Response Envelope ─────────────────────────────────────────────────────

export interface OndoPerpsApiResponse<T> {
  success: boolean;
  result: T;
  error_code?: string;
  message?: string;
}

// ── Markets / Contracts ───────────────────────────────────────────────────────

export interface OndoPerpsContract {
  market: string;          // e.g. "NVDA-USD.P"
  baseAsset: string;       // e.g. "NVDA"
  quoteAsset: string;      // e.g. "USD"
  status: string;          // e.g. "active"
  tickSize: string;        // price tick size
  stepSize: string;        // quantity step size
  minOrderSize: string;    // minimum order quantity
  maxLeverage: number;
  markPrice: string;
  indexPrice: string;
  lastPrice: string;
  volume24h: string;
  openInterest: string;
}

// ── Orders ────────────────────────────────────────────────────────────────────

export interface OndoPerpsOrderRequest {
  market: string;                     // e.g. "NVDA-USD.P"
  type: 'limit' | 'market';
  side: 'buy' | 'sell';
  size: string;                       // quantity in base asset
  price?: string;                     // required for limit
  clientOrderId?: string;
  postOnly?: boolean;
  reduceOnly?: boolean;
  timeInForce?: 'GTC' | 'IOC' | 'FOK';
  builderCode?: {
    code?: string;
    feeRateBps?: number;
  };
}

export interface OndoPerpsOrderResponse {
  orderId: string;
  clientOrderId?: string;
  market: string;
  side: 'buy' | 'sell';
  type: 'limit' | 'market';
  size: string;
  price: string;
  filledSize: string;
  avgFillPrice?: string;
  status: 'open' | 'closed' | 'cancelled' | 'partially_filled' | 'new';
  createdAt: string;
  reduceOnly?: boolean;
  postOnly?: boolean;
}

// ── Positions ─────────────────────────────────────────────────────────────────

export interface OndoPerpsPosition {
  market: string;
  side: 'long' | 'short';
  size: string;
  entryPrice: string;
  markPrice: string;
  liquidationPrice: string;
  unrealizedPnl: string;
  realizedPnl?: string;
  leverage: number;
  notionalValue?: string;
}

// ── Balance ───────────────────────────────────────────────────────────────────

export interface OndoPerpsBalance {
  marginBalance: string;
  availableMargin: string;
  usedMargin: string;
  unrealizedPnl: string;
  walletBalance: string;
}

// ── Account ───────────────────────────────────────────────────────────────────

export interface OndoPerpsAccount {
  accountID: string;
}

// ── Orderbook ─────────────────────────────────────────────────────────────────

export interface OndoPerpsDepth {
  bids: [string, string][];   // [price, size][]
  asks: [string, string][];
  market: string;
}

// ── Trades ────────────────────────────────────────────────────────────────────

export interface OndoPerpsPublicTrade {
  id: string;
  market: string;
  side: 'buy' | 'sell';
  price: string;
  size: string;
  createdAt: string;
}

// ── Mark Prices ───────────────────────────────────────────────────────────────

export interface OndoPerpsMarkPrice {
  market: string;
  markPrice: string;
  indexPrice: string;
}

// ── Candles ───────────────────────────────────────────────────────────────────

export interface OndoPerpsCandle {
  startTime: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

// ── Funding Rates ─────────────────────────────────────────────────────────────

export interface OndoPerpseFundingRate {
  market: string;
  fundingRate: string;
  nextFundingTime: string;
}

// ── Market Info cache entry ───────────────────────────────────────────────────

export interface MarketInfo {
  market: string;
  tickSize: number;
  stepSize: number;
  minOrderSize: number;
  maxLeverage: number;
  priceDecimals: number;
  sizeDecimals: number;
}
