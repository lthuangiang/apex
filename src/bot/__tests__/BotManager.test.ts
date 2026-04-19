import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BotManager } from '../BotManager.js';
import { BotInstance } from '../BotInstance.js';
import type { BotConfig } from '../types.js';
import type { ExchangeAdapter } from '../../adapters/ExchangeAdapter.js';
import type { TelegramManager } from '../../modules/TelegramManager.js';

// Mock dependencies
const mockAdapter: ExchangeAdapter = {
  get_mark_price: vi.fn(),
  get_orderbook: vi.fn(),
  place_limit_order: vi.fn(),
  cancel_order: vi.fn(),
  cancel_all_orders: vi.fn(),
  get_open_orders: vi.fn(),
  get_position: vi.fn(),
  get_balance: vi.fn(),
  get_orderbook_depth: vi.fn(),
  get_recent_trades: vi.fn(),
};

const mockTelegram: TelegramManager = {
  sendMessage: vi.fn(),
  setupMenu: vi.fn(),
  onCommand: vi.fn(),
  onCallback: vi.fn(),
  sendMessageWithInlineButtons: vi.fn(),
} as any;

const createTestConfig = (id: string): BotConfig => ({
  id,
  name: `Test Bot ${id}`,
  exchange: 'sodex',
  symbol: 'BTC-USD',
  tags: ['test'],
  autoStart: false,
  mode: 'farm',
  orderSizeMin: 0.003,
  orderSizeMax: 0.005,
  credentialKey: 'TEST',
  tradeLogBackend: 'json',
  tradeLogPath: `./trades-${id}.json`,
});

describe('BotManager', () => {
  let manager: BotManager;

  beforeEach(() => {
    manager = new BotManager();
  });

  describe('createBot', () => {
    it('should create and register a bot instance', () => {
      const config = createTestConfig('bot1');
      const bot = manager.createBot(config, mockAdapter, mockTelegram);

      expect(bot).toBeInstanceOf(BotInstance);
      expect(bot.id).toBe('bot1');
      expect(manager.getBot('bot1')).toBe(bot);
    });

    it('should throw error when creating bot with duplicate ID', () => {
      const config = createTestConfig('bot1');
      manager.createBot(config, mockAdapter, mockTelegram);

      expect(() => {
        manager.createBot(config, mockAdapter, mockTelegram);
      }).toThrow('Bot with id "bot1" already exists');
    });
  });

  describe('removeBot', () => {
    it('should remove a stopped bot from registry', () => {
      const config = createTestConfig('bot1');
      manager.createBot(config, mockAdapter, mockTelegram);

      manager.removeBot('bot1');
      expect(manager.getBot('bot1')).toBeUndefined();
    });

    it('should throw error when removing a running bot', async () => {
      const config = createTestConfig('bot1');
      const bot = manager.createBot(config, mockAdapter, mockTelegram);

      // Mock bot as running
      bot.state.botStatus = 'RUNNING';

      expect(() => {
        manager.removeBot('bot1');
      }).toThrow('Cannot remove running bot "bot1". Stop it first.');
    });

    it('should not throw when removing non-existent bot', () => {
      expect(() => {
        manager.removeBot('non-existent');
      }).not.toThrow();
    });
  });

  describe('getBot', () => {
    it('should return bot instance by ID', () => {
      const config = createTestConfig('bot1');
      const bot = manager.createBot(config, mockAdapter, mockTelegram);

      expect(manager.getBot('bot1')).toBe(bot);
    });

    it('should return undefined for non-existent bot', () => {
      expect(manager.getBot('non-existent')).toBeUndefined();
    });
  });

  describe('getAllBots', () => {
    it('should return empty array when no bots', () => {
      expect(manager.getAllBots()).toEqual([]);
    });

    it('should return all bot instances', () => {
      const config1 = createTestConfig('bot1');
      const config2 = createTestConfig('bot2');

      const bot1 = manager.createBot(config1, mockAdapter, mockTelegram);
      const bot2 = manager.createBot(config2, mockAdapter, mockTelegram);

      const allBots = manager.getAllBots();
      expect(allBots).toHaveLength(2);
      expect(allBots).toContain(bot1);
      expect(allBots).toContain(bot2);
    });
  });

  describe('startBot', () => {
    it('should start a bot by ID', async () => {
      const config = createTestConfig('bot1');
      const bot = manager.createBot(config, mockAdapter, mockTelegram);

      // Mock start method
      vi.spyOn(bot, 'start').mockResolvedValue(true);

      const result = await manager.startBot('bot1');
      expect(result).toBe(true);
      expect(bot.start).toHaveBeenCalled();
    });

    it('should throw error when starting non-existent bot', async () => {
      await expect(manager.startBot('non-existent')).rejects.toThrow('Bot "non-existent" not found');
    });
  });

  describe('stopBot', () => {
    it('should stop a bot by ID', async () => {
      const config = createTestConfig('bot1');
      const bot = manager.createBot(config, mockAdapter, mockTelegram);

      // Mock stop method
      vi.spyOn(bot, 'stop').mockResolvedValue();

      await manager.stopBot('bot1');
      expect(bot.stop).toHaveBeenCalled();
    });

    it('should throw error when stopping non-existent bot', async () => {
      await expect(manager.stopBot('non-existent')).rejects.toThrow('Bot "non-existent" not found');
    });
  });

  describe('getAggregatedStats', () => {
    it('should return zero stats when no bots', () => {
      const stats = manager.getAggregatedStats();

      expect(stats).toEqual({
        totalVolume: 0,
        activeBotCount: 0,
        totalFees: 0,
        totalPnl: 0,
      });
    });

    it('should aggregate stats from all bots', () => {
      const config1 = createTestConfig('bot1');
      const config2 = createTestConfig('bot2');

      const bot1 = manager.createBot(config1, mockAdapter, mockTelegram);
      const bot2 = manager.createBot(config2, mockAdapter, mockTelegram);

      // Set bot states
      bot1.state.sessionVolume = 100;
      bot1.state.sessionFees = 5;
      bot1.state.sessionPnl = 10;
      bot1.state.botStatus = 'RUNNING';

      bot2.state.sessionVolume = 200;
      bot2.state.sessionFees = 10;
      bot2.state.sessionPnl = -5;
      bot2.state.botStatus = 'STOPPED';

      const stats = manager.getAggregatedStats();

      expect(stats.totalVolume).toBe(300);
      expect(stats.totalFees).toBe(15);
      expect(stats.totalPnl).toBe(5);
      expect(stats.activeBotCount).toBe(1);
    });

    it('should count only running bots as active', () => {
      const config1 = createTestConfig('bot1');
      const config2 = createTestConfig('bot2');
      const config3 = createTestConfig('bot3');

      const bot1 = manager.createBot(config1, mockAdapter, mockTelegram);
      const bot2 = manager.createBot(config2, mockAdapter, mockTelegram);
      const bot3 = manager.createBot(config3, mockAdapter, mockTelegram);

      bot1.state.botStatus = 'RUNNING';
      bot2.state.botStatus = 'RUNNING';
      bot3.state.botStatus = 'STOPPED';

      const stats = manager.getAggregatedStats();
      expect(stats.activeBotCount).toBe(2);
    });
  });

  describe('getBotCount', () => {
    it('should return 0 when no bots', () => {
      expect(manager.getBotCount()).toBe(0);
    });

    it('should return correct count of bots', () => {
      manager.createBot(createTestConfig('bot1'), mockAdapter, mockTelegram);
      manager.createBot(createTestConfig('bot2'), mockAdapter, mockTelegram);
      manager.createBot(createTestConfig('bot3'), mockAdapter, mockTelegram);

      expect(manager.getBotCount()).toBe(3);
    });
  });
});
