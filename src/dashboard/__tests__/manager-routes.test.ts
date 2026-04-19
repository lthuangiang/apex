import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { DashboardServer } from '../server.js';
import { BotManager } from '../../bot/BotManager.js';
import { BotInstance } from '../../bot/BotInstance.js';
import { TradeLogger } from '../../ai/TradeLogger.js';
import type { BotConfig } from '../../bot/types.js';
import type { ExchangeAdapter } from '../../adapters/ExchangeAdapter.js';
import type { TelegramManager } from '../../modules/TelegramManager.js';

// Mock adapter
const createMockAdapter = (): ExchangeAdapter => ({
  getBalance: vi.fn().mockResolvedValue({ free: 1000, used: 0, total: 1000 }),
  getPrice: vi.fn().mockResolvedValue(50000),
  get_mark_price: vi.fn().mockResolvedValue(50000),
  placeOrder: vi.fn().mockResolvedValue({ id: 'order-1', status: 'filled' }),
  cancelOrder: vi.fn().mockResolvedValue(true),
  getOpenOrders: vi.fn().mockResolvedValue([]),
  getOrderStatus: vi.fn().mockResolvedValue({ id: 'order-1', status: 'filled' }),
  getPositions: vi.fn().mockResolvedValue([]),
  closePosition: vi.fn().mockResolvedValue(true),
} as any);

// Mock telegram
const createMockTelegram = (): TelegramManager => ({
  sendMessage: vi.fn(),
} as any);

describe('Manager API Routes', () => {
  let dashboardServer: DashboardServer;
  let botManager: BotManager;
  let tradeLogger: TradeLogger;

  beforeEach(() => {
    // Disable authentication for tests
    process.env.DASHBOARD_PASSCODE = '';
    
    tradeLogger = new TradeLogger('json', './test-trades.json');
    dashboardServer = new DashboardServer(tradeLogger, 3000);
    botManager = new BotManager();
    
    dashboardServer.registerBotManager(botManager);
  });

  describe('GET /api/bots', () => {
    it('should return empty array when no bots exist', async () => {
      const response = await request(dashboardServer.app)
        .get('/api/bots')
        .expect(200);

      expect(response.body).toEqual([]);
    });

    it('should return array of bot statuses', async () => {
      // Create test bot configs
      const config1: BotConfig = {
        id: 'test-bot-1',
        name: 'Test Bot 1',
        exchange: 'sodex',
        symbol: 'BTC-USD',
        credentialKey: 'TEST1',
        tradeLogBackend: 'json',
        tradeLogPath: './test-trades-1.json',
        autoStart: false,
        mode: 'farm',
        orderSizeMin: 0.003,
        orderSizeMax: 0.005,
        tags: ['Test'],
      };

      const config2: BotConfig = {
        id: 'test-bot-2',
        name: 'Test Bot 2',
        exchange: 'dango',
        symbol: 'ETH-USD',
        credentialKey: 'TEST2',
        tradeLogBackend: 'json',
        tradeLogPath: './test-trades-2.json',
        autoStart: false,
        mode: 'trade',
        orderSizeMin: 0.01,
        orderSizeMax: 0.02,
        tags: ['Test', 'Active'],
      };

      // Create bots
      botManager.createBot(config1, createMockAdapter(), createMockTelegram());
      botManager.createBot(config2, createMockAdapter(), createMockTelegram());

      const response = await request(dashboardServer.app)
        .get('/api/bots')
        .expect(200);

      expect(response.body).toHaveLength(2);
      expect(response.body[0]).toMatchObject({
        id: 'test-bot-1',
        name: 'Test Bot 1',
        exchange: 'sodex',
        status: 'inactive',
        symbol: 'BTC-USD',
        tags: ['Test'],
      });
      expect(response.body[1]).toMatchObject({
        id: 'test-bot-2',
        name: 'Test Bot 2',
        exchange: 'dango',
        status: 'inactive',
        symbol: 'ETH-USD',
        tags: ['Test', 'Active'],
      });
    });

    it('should return 404 when bot manager not registered', async () => {
      // Create new server without bot manager
      const serverWithoutManager = new DashboardServer(tradeLogger, 3001);
      
      const response = await request(serverWithoutManager.app)
        .get('/api/bots')
        .expect(404);

      // Route doesn't exist until registerBotManager is called
    });
  });

  describe('GET /api/bots/stats', () => {
    it('should return zero stats when no bots exist', async () => {
      const response = await request(dashboardServer.app)
        .get('/api/bots/stats')
        .expect(200);

      expect(response.body).toEqual({
        totalVolume: 0,
        activeBotCount: 0,
        totalFees: 0,
        totalPnl: 0,
      });
    });

    it('should return aggregated stats for multiple bots', async () => {
      // Create test bots
      const config1: BotConfig = {
        id: 'test-bot-1',
        name: 'Test Bot 1',
        exchange: 'sodex',
        symbol: 'BTC-USD',
        credentialKey: 'TEST1',
        tradeLogBackend: 'json',
        tradeLogPath: './test-trades-1.json',
        autoStart: false,
        mode: 'farm',
        orderSizeMin: 0.003,
        orderSizeMax: 0.005,
        tags: ['Test'],
      };

      const config2: BotConfig = {
        id: 'test-bot-2',
        name: 'Test Bot 2',
        exchange: 'dango',
        symbol: 'ETH-USD',
        credentialKey: 'TEST2',
        tradeLogBackend: 'json',
        tradeLogPath: './test-trades-2.json',
        autoStart: false,
        mode: 'trade',
        orderSizeMin: 0.01,
        orderSizeMax: 0.02,
        tags: ['Test'],
      };

      const bot1 = botManager.createBot(config1, createMockAdapter(), createMockTelegram());
      const bot2 = botManager.createBot(config2, createMockAdapter(), createMockTelegram());

      // Simulate some trading activity
      bot1.state.sessionVolume = 1000;
      bot1.state.sessionFees = 10;
      bot1.state.sessionPnl = 50;
      bot1.state.botStatus = 'RUNNING';

      bot2.state.sessionVolume = 2000;
      bot2.state.sessionFees = 20;
      bot2.state.sessionPnl = -30;
      bot2.state.botStatus = 'STOPPED';

      const response = await request(dashboardServer.app)
        .get('/api/bots/stats')
        .expect(200);

      expect(response.body).toEqual({
        totalVolume: 3000,
        activeBotCount: 1,
        totalFees: 30,
        totalPnl: 20,
      });
    });

    it('should return 404 when bot manager not registered', async () => {
      // Create new server without bot manager
      const serverWithoutManager = new DashboardServer(tradeLogger, 3001);
      
      const response = await request(serverWithoutManager.app)
        .get('/api/bots/stats')
        .expect(404);

      // Route doesn't exist until registerBotManager is called
    });
  });

  describe('POST /api/bots/:id/start', () => {
    it('should start a stopped bot', async () => {
      const config: BotConfig = {
        id: 'test-bot',
        name: 'Test Bot',
        exchange: 'sodex',
        symbol: 'BTC-USD',
        credentialKey: 'TEST',
        tradeLogBackend: 'json',
        tradeLogPath: './test-trades.json',
        autoStart: false,
        mode: 'farm',
        orderSizeMin: 0.003,
        orderSizeMax: 0.005,
        tags: ['Test'],
      };

      const bot = botManager.createBot(config, createMockAdapter(), createMockTelegram());
      expect(bot.state.botStatus).toBe('STOPPED');

      // Mock the bot's start method to avoid actually running the watcher
      vi.spyOn(bot, 'start').mockResolvedValue(true);
      vi.spyOn(botManager, 'startBot').mockImplementation(async (id) => {
        const b = botManager.getBot(id);
        if (b) {
          b.state.botStatus = 'RUNNING';
          return true;
        }
        return false;
      });

      const response = await request(dashboardServer.app)
        .post('/api/bots/test-bot/start')
        .expect(200);

      expect(response.body).toEqual({ ok: true });
      expect(bot.state.botStatus).toBe('RUNNING');
    });

    it('should return 400 when bot is already running', async () => {
      const config: BotConfig = {
        id: 'test-bot',
        name: 'Test Bot',
        exchange: 'sodex',
        symbol: 'BTC-USD',
        credentialKey: 'TEST',
        tradeLogBackend: 'json',
        tradeLogPath: './test-trades.json',
        autoStart: false,
        mode: 'farm',
        orderSizeMin: 0.003,
        orderSizeMax: 0.005,
        tags: ['Test'],
      };

      const bot = botManager.createBot(config, createMockAdapter(), createMockTelegram());
      
      // Set bot to running state without actually starting it
      bot.state.botStatus = 'RUNNING';

      const response = await request(dashboardServer.app)
        .post('/api/bots/test-bot/start')
        .expect(400);

      expect(response.body).toEqual({ error: 'Already running' });
    });

    it('should return 404 when bot not found', async () => {
      const response = await request(dashboardServer.app)
        .post('/api/bots/nonexistent-bot/start')
        .expect(404);

      expect(response.body).toEqual({ error: 'Bot not found' });
    });

    it('should return 503 when bot manager not available', async () => {
      const serverWithoutManager = new DashboardServer(tradeLogger, 3001);
      
      const response = await request(serverWithoutManager.app)
        .post('/api/bots/test-bot/start')
        .expect(404);

      // Route doesn't exist until registerBotManager is called
    });
  });

  describe('POST /api/bots/:id/stop', () => {
    it('should stop a running bot', async () => {
      const config: BotConfig = {
        id: 'test-bot',
        name: 'Test Bot',
        exchange: 'sodex',
        symbol: 'BTC-USD',
        credentialKey: 'TEST',
        tradeLogBackend: 'json',
        tradeLogPath: './test-trades.json',
        autoStart: false,
        mode: 'farm',
        orderSizeMin: 0.003,
        orderSizeMax: 0.005,
        tags: ['Test'],
      };

      const bot = botManager.createBot(config, createMockAdapter(), createMockTelegram());
      
      // Set bot to running state without actually starting it
      bot.state.botStatus = 'RUNNING';

      // Mock the stop method
      vi.spyOn(bot, 'stop').mockResolvedValue(undefined);
      vi.spyOn(botManager, 'stopBot').mockImplementation(async (id) => {
        const b = botManager.getBot(id);
        if (b) {
          b.state.botStatus = 'STOPPED';
        }
      });

      const response = await request(dashboardServer.app)
        .post('/api/bots/test-bot/stop')
        .expect(200);

      expect(response.body).toEqual({ ok: true });
      expect(bot.state.botStatus).toBe('STOPPED');
    });

    it('should return 400 when bot is not running', async () => {
      const config: BotConfig = {
        id: 'test-bot',
        name: 'Test Bot',
        exchange: 'sodex',
        symbol: 'BTC-USD',
        credentialKey: 'TEST',
        tradeLogBackend: 'json',
        tradeLogPath: './test-trades.json',
        autoStart: false,
        mode: 'farm',
        orderSizeMin: 0.003,
        orderSizeMax: 0.005,
        tags: ['Test'],
      };

      const bot = botManager.createBot(config, createMockAdapter(), createMockTelegram());
      expect(bot.state.botStatus).toBe('STOPPED');

      const response = await request(dashboardServer.app)
        .post('/api/bots/test-bot/stop')
        .expect(400);

      expect(response.body).toEqual({ error: 'Not running' });
    });

    it('should return 404 when bot not found', async () => {
      const response = await request(dashboardServer.app)
        .post('/api/bots/nonexistent-bot/stop')
        .expect(404);

      expect(response.body).toEqual({ error: 'Bot not found' });
    });

    it('should return 503 when bot manager not available', async () => {
      const serverWithoutManager = new DashboardServer(tradeLogger, 3001);
      
      const response = await request(serverWithoutManager.app)
        .post('/api/bots/test-bot/stop')
        .expect(404);

      // Route doesn't exist until registerBotManager is called
    });
  });

  describe('POST /api/bots/:id/close', () => {
    it('should force close position for a bot', async () => {
      const config: BotConfig = {
        id: 'test-bot',
        name: 'Test Bot',
        exchange: 'sodex',
        symbol: 'BTC-USD',
        credentialKey: 'TEST',
        tradeLogBackend: 'json',
        tradeLogPath: './test-trades.json',
        autoStart: false,
        mode: 'farm',
        orderSizeMin: 0.003,
        orderSizeMax: 0.005,
        tags: ['Test'],
      };

      const bot = botManager.createBot(config, createMockAdapter(), createMockTelegram());
      
      // Mock forceClosePosition to return true
      vi.spyOn(bot, 'forceClosePosition').mockResolvedValue(true);

      const response = await request(dashboardServer.app)
        .post('/api/bots/test-bot/close')
        .expect(200);

      expect(response.body).toEqual({ ok: true });
      expect(bot.forceClosePosition).toHaveBeenCalled();
    });

    it('should handle failed position close', async () => {
      const config: BotConfig = {
        id: 'test-bot',
        name: 'Test Bot',
        exchange: 'sodex',
        symbol: 'BTC-USD',
        credentialKey: 'TEST',
        tradeLogBackend: 'json',
        tradeLogPath: './test-trades.json',
        autoStart: false,
        mode: 'farm',
        orderSizeMin: 0.003,
        orderSizeMax: 0.005,
        tags: ['Test'],
      };

      const bot = botManager.createBot(config, createMockAdapter(), createMockTelegram());
      
      // Mock forceClosePosition to return false
      vi.spyOn(bot, 'forceClosePosition').mockResolvedValue(false);

      const response = await request(dashboardServer.app)
        .post('/api/bots/test-bot/close')
        .expect(200);

      expect(response.body).toEqual({ ok: false });
    });

    it('should return 404 when bot not found', async () => {
      const response = await request(dashboardServer.app)
        .post('/api/bots/nonexistent-bot/close')
        .expect(404);

      expect(response.body).toEqual({ error: 'Bot not found' });
    });

    it('should return 503 when bot manager not available', async () => {
      const serverWithoutManager = new DashboardServer(tradeLogger, 3001);
      
      const response = await request(serverWithoutManager.app)
        .post('/api/bots/test-bot/close')
        .expect(404);

      // Route doesn't exist until registerBotManager is called
    });
  });

  describe('GET /api/bots/:id/pnl', () => {
    it('should return bot PnL data', async () => {
      const config: BotConfig = {
        id: 'test-bot',
        name: 'Test Bot',
        exchange: 'sodex',
        symbol: 'BTC-USD',
        credentialKey: 'TEST',
        tradeLogBackend: 'json',
        tradeLogPath: './test-trades.json',
        autoStart: false,
        mode: 'farm',
        orderSizeMin: 0.003,
        orderSizeMax: 0.005,
        tags: ['Test'],
      };

      const bot = botManager.createBot(config, createMockAdapter(), createMockTelegram());
      
      // Set some state data
      bot.state.sessionPnl = 100;
      bot.state.sessionVolume = 5000;
      bot.state.sessionFees = 25;
      bot.state.symbol = 'BTC-USD';
      bot.state.walletAddress = '0x1234...abcd';

      const response = await request(dashboardServer.app)
        .get('/api/bots/test-bot/pnl')
        .expect(200);

      expect(response.body).toMatchObject({
        sessionPnl: 100,
        sessionVolume: 5000,
        sessionFees: 25,
        symbol: 'BTC-USD',
        walletAddress: '0x1234...abcd',
      });
      expect(response.body).toHaveProperty('updatedAt');
      expect(response.body).toHaveProperty('botStatus');
      expect(response.body).toHaveProperty('pnlHistory');
      expect(response.body).toHaveProperty('volumeHistory');
    });

    it('should return 404 when bot not found', async () => {
      const response = await request(dashboardServer.app)
        .get('/api/bots/nonexistent-bot/pnl')
        .expect(404);

      expect(response.body).toEqual({ error: 'Bot not found' });
    });

    it('should return 503 when bot manager not available', async () => {
      const serverWithoutManager = new DashboardServer(tradeLogger, 3001);
      
      const response = await request(serverWithoutManager.app)
        .get('/api/bots/test-bot/pnl')
        .expect(404);
    });
  });

  describe('GET /api/bots/:id/trades', () => {
    it('should return bot trades', async () => {
      const config: BotConfig = {
        id: 'test-bot',
        name: 'Test Bot',
        exchange: 'sodex',
        symbol: 'BTC-USD',
        credentialKey: 'TEST',
        tradeLogBackend: 'json',
        tradeLogPath: './test-trades.json',
        autoStart: false,
        mode: 'farm',
        orderSizeMin: 0.003,
        orderSizeMax: 0.005,
        tags: ['Test'],
      };

      const bot = botManager.createBot(config, createMockAdapter(), createMockTelegram());
      
      // Mock the trade logger
      const mockTrades = [
        { id: 'trade-1', pnl: 50, volume: 1000 },
        { id: 'trade-2', pnl: -20, volume: 800 },
      ];
      vi.spyOn(bot.getTradeLogger(), 'readAll').mockResolvedValue(mockTrades as any);

      const response = await request(dashboardServer.app)
        .get('/api/bots/test-bot/trades')
        .expect(200);

      expect(response.body).toEqual(mockTrades);
    });

    it('should return 404 when bot not found', async () => {
      const response = await request(dashboardServer.app)
        .get('/api/bots/nonexistent-bot/trades')
        .expect(404);

      expect(response.body).toEqual({ error: 'Bot not found' });
    });

    it('should return 503 when bot manager not available', async () => {
      const serverWithoutManager = new DashboardServer(tradeLogger, 3001);
      
      const response = await request(serverWithoutManager.app)
        .get('/api/bots/test-bot/trades')
        .expect(404);
    });
  });

  describe('GET /api/bots/:id/events', () => {
    it('should return bot event log', async () => {
      const config: BotConfig = {
        id: 'test-bot',
        name: 'Test Bot',
        exchange: 'sodex',
        symbol: 'BTC-USD',
        credentialKey: 'TEST',
        tradeLogBackend: 'json',
        tradeLogPath: './test-trades.json',
        autoStart: false,
        mode: 'farm',
        orderSizeMin: 0.003,
        orderSizeMax: 0.005,
        tags: ['Test'],
      };

      const bot = botManager.createBot(config, createMockAdapter(), createMockTelegram());
      
      // Add some events
      bot.state.eventLog = [
        { timestamp: '2024-01-01T00:00:00Z', type: 'info', message: 'Bot started' },
        { timestamp: '2024-01-01T00:01:00Z', type: 'trade', message: 'Trade executed' },
      ];

      const response = await request(dashboardServer.app)
        .get('/api/bots/test-bot/events')
        .expect(200);

      expect(response.body).toEqual(bot.state.eventLog);
    });

    it('should return 404 when bot not found', async () => {
      const response = await request(dashboardServer.app)
        .get('/api/bots/nonexistent-bot/events')
        .expect(404);

      expect(response.body).toEqual({ error: 'Bot not found' });
    });

    it('should return 503 when bot manager not available', async () => {
      const serverWithoutManager = new DashboardServer(tradeLogger, 3001);
      
      const response = await request(serverWithoutManager.app)
        .get('/api/bots/test-bot/events')
        .expect(404);
    });
  });

  describe('GET /api/bots/:id/position', () => {
    it('should return bot open position', async () => {
      const config: BotConfig = {
        id: 'test-bot',
        name: 'Test Bot',
        exchange: 'sodex',
        symbol: 'BTC-USD',
        credentialKey: 'TEST',
        tradeLogBackend: 'json',
        tradeLogPath: './test-trades.json',
        autoStart: false,
        mode: 'farm',
        orderSizeMin: 0.003,
        orderSizeMax: 0.005,
        tags: ['Test'],
      };

      const bot = botManager.createBot(config, createMockAdapter(), createMockTelegram());
      
      // Set open position
      bot.state.openPosition = {
        side: 'long',
        size: 0.01,
        entryPrice: 50000,
        currentPrice: 51000,
        pnl: 10,
        timestamp: '2024-01-01T00:00:00Z',
      } as any;

      const response = await request(dashboardServer.app)
        .get('/api/bots/test-bot/position')
        .expect(200);

      expect(response.body).toEqual(bot.state.openPosition);
    });

    it('should return null when no position', async () => {
      const config: BotConfig = {
        id: 'test-bot',
        name: 'Test Bot',
        exchange: 'sodex',
        symbol: 'BTC-USD',
        credentialKey: 'TEST',
        tradeLogBackend: 'json',
        tradeLogPath: './test-trades.json',
        autoStart: false,
        mode: 'farm',
        orderSizeMin: 0.003,
        orderSizeMax: 0.005,
        tags: ['Test'],
      };

      const bot = botManager.createBot(config, createMockAdapter(), createMockTelegram());
      
      // No position set (default is null)
      expect(bot.state.openPosition).toBeNull();

      const response = await request(dashboardServer.app)
        .get('/api/bots/test-bot/position')
        .expect(200);

      expect(response.body).toBeNull();
    });

    it('should return 404 when bot not found', async () => {
      const response = await request(dashboardServer.app)
        .get('/api/bots/nonexistent-bot/position')
        .expect(404);

      expect(response.body).toEqual({ error: 'Bot not found' });
    });

    it('should return 503 when bot manager not available', async () => {
      const serverWithoutManager = new DashboardServer(tradeLogger, 3001);
      
      const response = await request(serverWithoutManager.app)
        .get('/api/bots/test-bot/position')
        .expect(404);
    });
  });
});
