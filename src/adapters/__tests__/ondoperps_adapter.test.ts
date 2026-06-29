import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OndoPerpsAdapter } from '../ondoperps_adapter';
import axios from 'axios';

vi.mock('axios');
const mockedAxios = axios as any;

describe('OndoPerpsAdapter', () => {
  let adapter: OndoPerpsAdapter;
  let mockCreate: any;

  beforeEach(() => {
    mockCreate = {
      request: vi.fn()
    };
    mockedAxios.create.mockReturnValue(mockCreate);

    adapter = new OndoPerpsAdapter({
      apiKeyId: 'test-key-id',
      apiKeySecret: 'test-secret',
      baseUrl: 'https://api.ondoperps.xyz/v1'
    });
  });

  describe('fetchMarkets', () => {
    it('should fetch and cache market info', async () => {
      mockCreate.request.mockResolvedValue({
        data: {
          success: true,
          result: [
            {
              market: 'XAU-USD.P',
              baseCurrency: 'XAU',
              quoteCurrency: 'USD',
              quoteIncrement: '0.01',
              baseIncrement: '0.01',
              minOrderSize: '0.01',
              maxOrderSize: '1000',
              status: 'active'
            },
            {
              market: 'AAPL-USD.P',
              baseCurrency: 'AAPL',
              quoteCurrency: 'USD',
              quoteIncrement: '0.01',
              baseIncrement: '1',
              minOrderSize: '1',
              maxOrderSize: '5000',
              status: 'active'
            }
          ]
        }
      });

      await adapter.fetchMarkets();

      expect(adapter.supportedSymbols).toContain('XAU-PERP');
      expect(adapter.supportedSymbols).toContain('AAPL-PERP');
      expect(mockCreate.request).toHaveBeenCalledWith({
        method: 'GET',
        url: '/perps/markets',
        data: undefined
      });
    });

    it('should skip inactive markets', async () => {
      mockCreate.request.mockResolvedValue({
        data: {
          success: true,
          result: [
            {
              market: 'XAU-USD.P',
              status: 'active',
              quoteIncrement: '0.01',
              baseIncrement: '0.01',
              minOrderSize: '0.01',
              maxOrderSize: '1000'
            },
            {
              market: 'TEST-USD.P',
              status: 'inactive',
              quoteIncrement: '0.0001',
              baseIncrement: '1',
              minOrderSize: '1',
              maxOrderSize: '100000'
            }
          ]
        }
      });

      await adapter.fetchMarkets();

      expect(adapter.supportedSymbols).toContain('XAU-PERP');
      expect(adapter.supportedSymbols).not.toContain('TEST-PERP');
    });
  });

  describe('getBalance', () => {
    it('should fetch and map balance', async () => {
      mockCreate.request.mockResolvedValue({
        data: {
          success: true,
          result: {
            accountId: 'test-account',
            balance: {
              totalEquity: '10000.50',
              availableBalance: '8500.25',
              usedMargin: '1500.25',
              unrealizedPnl: '250.50',
              currency: 'USD'
            },
            positions: []
          }
        }
      });

      const balance = await adapter.getBalance();

      expect(balance).toEqual({
        total: 10000.50,
        available: 8500.25,
        currency: 'USD'
      });
    });
  });

  describe('getPositions', () => {
    it('should fetch and map positions', async () => {
      mockCreate.request.mockResolvedValue({
        data: {
          success: true,
          result: {
            accountId: 'test-account',
            balance: {
              totalEquity: '10000',
              availableBalance: '8000',
              usedMargin: '2000',
              unrealizedPnl: '100',
              currency: 'USD'
            },
            positions: [
              {
                market: 'XAU-USD.P',
                side: 'long',
                size: '10',
                entryPrice: '2000',
                markPrice: '2050',
                liquidationPrice: '1800',
                unrealizedPnl: '500',
                realizedPnl: '0',
                leverage: 10
              }
            ]
          }
        }
      });

      const positions = await adapter.getPositions();

      expect(positions).toHaveLength(1);
      expect(positions[0]).toEqual({
        symbol: 'XAU-PERP',
        side: 'long',
        size: 10,
        entryPrice: 2000,
        markPrice: 2050,
        liquidationPrice: 1800,
        unrealizedPnl: 500,
        leverage: 10
      });
    });
  });

  describe('placeOrder', () => {
    beforeEach(async () => {
      mockCreate.request.mockResolvedValueOnce({
        data: {
          success: true,
          result: [
            {
              market: 'XAU-USD.P',
              quoteIncrement: '0.01',
              baseIncrement: '0.01',
              minOrderSize: '0.01',
              maxOrderSize: '1000',
              status: 'active'
            }
          ]
        }
      });
      await adapter.fetchMarkets();
    });

    it('should place limit buy order', async () => {
      mockCreate.request.mockResolvedValue({
        data: {
          success: true,
          result: {
            orderId: 'order-123',
            clientOrderId: 'drift_test',
            side: 'buy',
            price: '2000.00',
            size: '10',
            market: 'XAU-USD.P',
            filledSize: '0',
            status: 'open',
            createdAt: '2026-06-16T00:00:00Z',
            type: 'limit',
            timeInForce: 'GTC'
          }
        }
      });

      const order = await adapter.placeOrder({
        symbol: 'XAU-PERP',
        side: 'long',
        type: 'LIMIT',
        price: 2000,
        size: 10
      });

      expect(order).toMatchObject({
        id: 'order-123',
        symbol: 'XAU-PERP',
        side: 'long',
        type: 'LIMIT',
        price: 2000,
        size: 10,
        filledSize: 0,
        status: 'OPEN'
      });

      expect(mockCreate.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          url: '/perps/orders',
          data: expect.objectContaining({
            side: 'buy',
            market: 'XAU-USD.P',
            type: 'limit',
            price: expect.any(String),
            size: expect.any(String)
          })
        })
      );
    });

    it('should place market sell order', async () => {
      mockCreate.request.mockResolvedValue({
        data: {
          success: true,
          result: {
            orderId: 'order-456',
            side: 'sell',
            price: '2000',
            size: '5',
            market: 'XAU-USD.P',
            filledSize: '5',
            status: 'closed',
            createdAt: '2026-06-16T00:00:00Z',
            type: 'market',
            timeInForce: 'GTC'
          }
        }
      });

      const order = await adapter.placeOrder({
        symbol: 'XAU-PERP',
        side: 'short',
        type: 'MARKET',
        size: 5
      });

      expect(order).toMatchObject({
        side: 'short',
        type: 'MARKET',
        status: 'FILLED'
      });

      expect(mockCreate.request).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            side: 'sell',
            type: 'market'
          })
        })
      );
    });

    it('should handle insufficient_margin error', async () => {
      mockCreate.request.mockRejectedValue({
        response: {
          data: {
            success: false,
            error_code: 'insufficient_margin',
            message: 'Not enough margin'
          }
        }
      });

      await expect(
        adapter.placeOrder({
          symbol: 'XAU-PERP',
          side: 'long',
          type: 'LIMIT',
          price: 2000,
          size: 1000
        })
      ).rejects.toThrow('Insufficient margin');
    });

    it('should handle post_only_has_match error', async () => {
      mockCreate.request.mockRejectedValue({
        response: {
          data: {
            error_code: 'post_only_has_match',
            message: 'Order would match immediately'
          }
        }
      });

      await expect(
        adapter.placeOrder({
          symbol: 'XAU-PERP',
          side: 'long',
          type: 'LIMIT',
          price: 2000,
          size: 10
        })
      ).rejects.toThrow('PostOnly order would match');
    });
  });

  describe('cancelOrder', () => {
    it('should cancel order by id', async () => {
      mockCreate.request.mockResolvedValue({
        data: { success: true, result: {} }
      });

      await adapter.cancelOrder('order-123');

      expect(mockCreate.request).toHaveBeenCalledWith({
        method: 'DELETE',
        url: '/perps/orders/order-123',
        data: undefined
      });
    });
  });

  describe('getOrder', () => {
    it('should fetch order by id', async () => {
      mockCreate.request.mockResolvedValue({
        data: {
          success: true,
          result: {
            orderId: 'order-789',
            clientOrderId: 'drift_xyz',
            side: 'buy',
            price: '2050.00',
            size: '10',
            market: 'XAU-USD.P',
            filledSize: '5',
            status: 'partially_filled',
            createdAt: '2026-06-16T00:00:00Z',
            type: 'limit',
            timeInForce: 'GTC'
          }
        }
      });

      const order = await adapter.getOrder('order-789');

      expect(order).toMatchObject({
        id: 'order-789',
        symbol: 'XAU-PERP',
        side: 'long',
        price: 2050,
        size: 10,
        filledSize: 5,
        status: 'OPEN'
      });
    });
  });

  describe('getOpenOrders', () => {
    it('should fetch all open orders', async () => {
      mockCreate.request.mockResolvedValue({
        data: {
          success: true,
          result: [
            {
              orderId: 'order-1',
              side: 'buy',
              price: '2000',
              size: '10',
              market: 'XAU-USD.P',
              filledSize: '0',
              status: 'open',
              createdAt: '2026-06-16T00:00:00Z',
              type: 'limit',
              timeInForce: 'GTC'
            },
            {
              orderId: 'order-2',
              side: 'sell',
              price: '180',
              size: '5',
              market: 'AAPL-USD.P',
              filledSize: '0',
              status: 'open',
              createdAt: '2026-06-16T00:00:00Z',
              type: 'limit',
              timeInForce: 'GTC'
            }
          ]
        }
      });

      const orders = await adapter.getOpenOrders();

      expect(orders).toHaveLength(2);
      expect(orders[0].symbol).toBe('XAU-PERP');
      expect(orders[1].symbol).toBe('AAPL-PERP');
    });

    it('should fetch open orders for specific symbol', async () => {
      mockCreate.request.mockResolvedValue({
        data: {
          success: true,
          result: [
            {
              orderId: 'order-1',
              side: 'buy',
              price: '2000',
              size: '10',
              market: 'XAU-USD.P',
              filledSize: '0',
              status: 'open',
              createdAt: '2026-06-16T00:00:00Z',
              type: 'limit',
              timeInForce: 'GTC'
            }
          ]
        }
      });

      const orders = await adapter.getOpenOrders('XAU-PERP');

      expect(orders).toHaveLength(1);
      expect(mockCreate.request).toHaveBeenCalledWith(
        expect.objectContaining({
          url: '/perps/orders?market=XAU-USD.P&status=open'
        })
      );
    });
  });

  describe('connection management', () => {
    it('should connect and fetch markets', async () => {
      mockCreate.request.mockResolvedValue({
        data: {
          success: true,
          result: []
        }
      });

      await adapter.connect();

      expect(adapter.isConnected()).toBe(true);
    });

    it('should disconnect', async () => {
      await adapter.disconnect();

      expect(adapter.isConnected()).toBe(false);
    });

    it('should return connection health', () => {
      const health = adapter.getConnectionHealth();

      expect(health).toHaveProperty('isConnected');
      expect(health).toHaveProperty('latency');
      expect(health).toHaveProperty('lastHeartbeat');
    });
  });
});
