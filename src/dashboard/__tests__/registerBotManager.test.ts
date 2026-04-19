import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DashboardServer } from '../server.js';
import { BotManager } from '../../bot/BotManager.js';
import { TradeLogger } from '../../ai/TradeLogger.js';

describe('DashboardServer.registerBotManager', () => {
  let dashboardServer: DashboardServer;
  let botManager: BotManager;
  let tradeLogger: TradeLogger;

  beforeEach(() => {
    tradeLogger = new TradeLogger('json', './test-trades.json');
    dashboardServer = new DashboardServer(tradeLogger, 3000);
    botManager = new BotManager();
  });

  it('should store reference to BotManager', () => {
    dashboardServer.registerBotManager(botManager);
    
    // Access private property for testing
    const server = dashboardServer as any;
    expect(server.botManager).toBe(botManager);
  });

  it('should call _setupManagerRoutes after registration', () => {
    const setupSpy = vi.spyOn(dashboardServer as any, '_setupManagerRoutes');
    
    dashboardServer.registerBotManager(botManager);
    
    expect(setupSpy).toHaveBeenCalledOnce();
  });

  it('should log registration message', () => {
    const consoleSpy = vi.spyOn(console, 'log');
    
    dashboardServer.registerBotManager(botManager);
    
    expect(consoleSpy).toHaveBeenCalledWith('[DashboardServer] BotManager registered');
  });
});
