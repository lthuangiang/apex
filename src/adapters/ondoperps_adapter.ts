import axios, { AxiosInstance } from 'axios';
import { ExchangeAdapter, Position, RawTrade } from './ExchangeAdapter.js';
import { Orderbook, OrderParams, ConnectionHealth, Order, OrderStatus } from '../types/core.js';
import {
  OndoPerpsConfig,
  OndoPerpsOrderRequest,
  OndoPerpsOrderResponse,
  OndoPerpsApiResponse,
  OndoPerpsMarket,
  OndoPerpsPosition,
  OndoPerpsBalance,
  OndoPerpsAccountResponse,
  MarketInfo
} from './types/ondoperps.types.js';

export class OndoPerpsAdapter implements ExchangeAdapter {
  readonly exchangeName = 'ondoperps';
  readonly supportedSymbols: string[] = [];

  private apiKeyId: string;
  private apiKeySecret: string;
  private baseUrl: string;
  private client: AxiosInstance;
  private marketCache = new Map<string, MarketInfo>();
  private connected = false;

  constructor(config: OndoPerpsConfig) {
    this.apiKeyId = config.apiKeyId;
    this.apiKeySecret = config.apiKeySecret;
    this.baseUrl = config.baseUrl || 'https://api.ondoperps.xyz/v1';

    this.client = axios.create({
      baseURL: this.baseUrl,
      headers: {
        'X-API-KEY-ID': this.apiKeyId,
        'Authorization': `Bearer ${this.apiKeySecret}`,
        'Content-Type': 'application/json'
      }
    });
  }

  private async request<T>(method: string, endpoint: string, data?: any): Promise<T> {
    try {
      const response = await this.client.request<OndoPerpsApiResponse<T>>({
        method,
        url: endpoint,
        data
      });
      return response.data.result;
    } catch (error: any) {
      this.handleApiError(error);
    }
  }

  private handleApiError(error: any): never {
    const errorCode = error.response?.data?.error_code;
    const message = error.response?.data?.message || error.message;

    switch (errorCode) {
      case 'insufficient_margin':
        throw new Error(`[OndoPerps] Insufficient margin: ${message}`);
      case 'account_in_liquidation':
        throw new Error(`[OndoPerps] Account in liquidation: ${message}`);
      case 'post_only_has_match':
        throw new Error(`[OndoPerps] PostOnly order would match: ${message}`);
      case 'too_many_requests':
        throw new Error(`[OndoPerps] Rate limit exceeded: ${message}`);
      case 'insufficient_funds':
        throw new Error(`[OndoPerps] Insufficient funds: ${message}`);
      case 'order_invalid_price':
        throw new Error(`[OndoPerps] Invalid price: ${message}`);
      case 'order_invalid_size':
        throw new Error(`[OndoPerps] Invalid size: ${message}`);
      default:
        throw new Error(`[OndoPerps] API Error: ${message}`);
    }
  }

  private mapSymbol(driftSymbol: string): string {
    // XAU-PERP → XAU-USD.P, AAPL-PERP → AAPL-USD.P
    return driftSymbol.replace('-PERP', '-USD.P');
  }

  private mapSide(driftSide: string): 'buy' | 'sell' {
    return driftSide.toLowerCase() === 'long' || driftSide.toLowerCase() === 'buy' ? 'buy' : 'sell';
  }

  private unmapSide(ondoSide: 'buy' | 'sell'): 'long' | 'short' {
    return ondoSide === 'buy' ? 'long' : 'short';
  }

  private roundToIncrement(value: number, increment: number): number {
    return Math.round(value / increment) * increment;
  }

  private async getMarketInfo(symbol: string): Promise<MarketInfo | undefined> {
    if (!this.marketCache.has(symbol)) {
      await this.fetchMarkets();
    }
    return this.marketCache.get(symbol);
  }

  async connect(): Promise<void> {
    await this.fetchMarkets();
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getConnectionHealth(): ConnectionHealth {
    return {
      isConnected: this.connected,
      latency: 0,
      lastHeartbeat: Date.now()
    };
  }

  async fetchMarkets(): Promise<void> {
    const markets = await this.request<OndoPerpsMarket[]>('GET', '/perps/markets');

    this.supportedSymbols.length = 0;
    this.marketCache.clear();

    for (const market of markets) {
      if (market.status === 'active') {
        const driftSymbol = market.market.replace('-USD.P', '-PERP');
        this.supportedSymbols.push(driftSymbol);

        this.marketCache.set(market.market, {
          quoteIncrement: parseFloat(market.quoteIncrement),
          baseIncrement: parseFloat(market.baseIncrement),
          minOrderSize: parseFloat(market.minOrderSize),
          maxOrderSize: parseFloat(market.maxOrderSize)
        });
      }
    }
  }

  async getBalance(): Promise<{ total: number; available: number; currency: string }> {
    const account = await this.request<OndoPerpsAccountResponse>('GET', '/account');

    return {
      total: parseFloat(account.balance.totalEquity),
      available: parseFloat(account.balance.availableBalance),
      currency: account.balance.currency
    };
  }

  async getPositions(): Promise<Position[]> {
    const account = await this.request<OndoPerpsAccountResponse>('GET', '/account');

    return account.positions.map(pos => ({
      symbol: pos.market.replace('-USD.P', '-PERP'),
      side: pos.side,
      size: parseFloat(pos.size),
      entryPrice: parseFloat(pos.entryPrice),
      markPrice: parseFloat(pos.markPrice),
      liquidationPrice: parseFloat(pos.liquidationPrice),
      unrealizedPnl: parseFloat(pos.unrealizedPnl),
      leverage: pos.leverage
    }));
  }

  async placeOrder(params: OrderParams): Promise<Order> {
    const ondoSymbol = this.mapSymbol(params.symbol);
    const marketInfo = await this.getMarketInfo(ondoSymbol);

    let price: string | undefined;
    let size: string | undefined;

    if (params.type.toUpperCase() === 'LIMIT') {
      if (!params.price) {
        throw new Error('[OndoPerps] Price required for limit orders');
      }

      if (marketInfo) {
        const roundedPrice = this.roundToIncrement(params.price, marketInfo.quoteIncrement);
        price = roundedPrice.toFixed(8);
      } else {
        price = params.price.toFixed(8);
      }
    }

    if (params.size) {
      if (marketInfo) {
        const roundedSize = this.roundToIncrement(params.size, marketInfo.baseIncrement);
        size = roundedSize.toFixed(8);
      } else {
        size = params.size.toFixed(8);
      }
    }

    const orderRequest: OndoPerpsOrderRequest = {
      side: this.mapSide(params.side),
      market: ondoSymbol,
      type: params.type.toLowerCase() as 'limit' | 'market',
      price,
      size,
      clientOrderId: `drift_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    };

    if (params.type.toUpperCase() === 'LIMIT' && params.timeInForce) {
      orderRequest.timeInForce = params.timeInForce as 'GTC' | 'IOC';
    }

    const response = await this.request<OndoPerpsOrderResponse>('POST', '/perps/orders', orderRequest);

    return {
      id: response.orderId,
      clientOrderId: response.clientOrderId,
      symbol: params.symbol,
      side: this.unmapSide(response.side),
      type: response.type.toUpperCase() as 'LIMIT' | 'MARKET',
      price: parseFloat(response.price),
      size: parseFloat(response.size),
      filledSize: parseFloat(response.filledSize),
      status: this.mapOrderStatus(response.status),
      timestamp: new Date(response.createdAt).getTime()
    };
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.request('DELETE', `/perps/orders/${orderId}`);
  }

  async getOrder(orderId: string): Promise<Order> {
    const response = await this.request<OndoPerpsOrderResponse>('GET', `/perps/orders/${orderId}`);

    return {
      id: response.orderId,
      clientOrderId: response.clientOrderId,
      symbol: response.market.replace('-USD.P', '-PERP'),
      side: this.unmapSide(response.side),
      type: response.type.toUpperCase() as 'LIMIT' | 'MARKET',
      price: parseFloat(response.price),
      size: parseFloat(response.size),
      filledSize: parseFloat(response.filledSize),
      status: this.mapOrderStatus(response.status),
      timestamp: new Date(response.createdAt).getTime()
    };
  }

  async getOpenOrders(symbol?: string): Promise<Order[]> {
    const endpoint = symbol
      ? `/perps/orders?market=${this.mapSymbol(symbol)}&status=open`
      : '/perps/orders?status=open';

    const response = await this.request<OndoPerpsOrderResponse[]>('GET', endpoint);

    return response.map(order => ({
      id: order.orderId,
      clientOrderId: order.clientOrderId,
      symbol: order.market.replace('-USD.P', '-PERP'),
      side: this.unmapSide(order.side),
      type: order.type.toUpperCase() as 'LIMIT' | 'MARKET',
      price: parseFloat(order.price),
      size: parseFloat(order.size),
      filledSize: parseFloat(order.filledSize),
      status: this.mapOrderStatus(order.status),
      timestamp: new Date(order.createdAt).getTime()
    }));
  }

  private mapOrderStatus(ondoStatus: string): OrderStatus {
    switch (ondoStatus) {
      case 'open':
      case 'partially_filled':
        return 'OPEN';
      case 'closed':
        return 'FILLED';
      case 'cancelled':
        return 'CANCELLED';
      default:
        return 'OPEN';
    }
  }

  // Not implemented methods (use defaults or throw)
  async getOrderbook(symbol: string): Promise<Orderbook> {
    throw new Error('[OndoPerps] getOrderbook not implemented');
  }

  async getRecentTrades(symbol: string, limit?: number): Promise<RawTrade[]> {
    throw new Error('[OndoPerps] getRecentTrades not implemented');
  }

  async subscribeToOrderbook(symbol: string, callback: (orderbook: Orderbook) => void): Promise<void> {
    throw new Error('[OndoPerps] WebSocket subscriptions not implemented');
  }

  async subscribeToTrades(symbol: string, callback: (trade: RawTrade) => void): Promise<void> {
    throw new Error('[OndoPerps] WebSocket subscriptions not implemented');
  }
}
