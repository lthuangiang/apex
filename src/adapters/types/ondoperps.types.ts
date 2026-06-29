// OndoPerps API Types

export interface OndoPerpsConfig {
  apiKeyId: string;
  apiKeySecret: string;
  baseUrl?: string;
}

export interface OndoPerpsOrderRequest {
  side: 'buy' | 'sell';
  market: string;
  price?: string;
  size?: string;
  quoteSize?: string;
  clientOrderId?: string;
  type?: 'limit' | 'market';
  timeInForce?: 'GTC' | 'IOC';
  postOnly?: boolean;
  reduceOnly?: boolean;
  takeProfit?: {
    triggerPrice: string;
  };
  stopLoss?: {
    triggerPrice: string;
  };
}

export interface OndoPerpsOrderResponse {
  orderId: string;
  clientOrderId?: string;
  side: 'buy' | 'sell';
  price: string;
  size: string;
  market: string;
  filledSize: string;
  status: 'open' | 'closed' | 'cancelled' | 'partially_filled';
  createdAt: string;
  type: 'limit' | 'market';
  timeInForce: 'GTC' | 'IOC';
}

export interface OndoPerpsApiResponse<T> {
  success: boolean;
  result: T;
}

export interface OndoPerpsApiError {
  success: false;
  error_code: string;
  message: string;
}

export interface OndoPerpsMarket {
  market: string;
  baseCurrency: string;
  quoteCurrency: string;
  quoteIncrement: string;
  baseIncrement: string;
  minOrderSize: string;
  maxOrderSize: string;
  status: 'active' | 'inactive';
}

export interface OndoPerpsPosition {
  market: string;
  side: 'long' | 'short';
  size: string;
  entryPrice: string;
  markPrice: string;
  liquidationPrice: string;
  unrealizedPnl: string;
  realizedPnl: string;
  leverage: number;
}

export interface OndoPerpsBalance {
  totalEquity: string;
  availableBalance: string;
  usedMargin: string;
  unrealizedPnl: string;
  currency: string;
}

export interface OndoPerpsAccountResponse {
  accountId: string;
  balance: OndoPerpsBalance;
  positions: OndoPerpsPosition[];
}

// Market info cache entry
export interface MarketInfo {
  quoteIncrement: number;
  baseIncrement: number;
  minOrderSize: number;
  maxOrderSize: number;
}
