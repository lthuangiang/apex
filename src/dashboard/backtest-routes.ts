import { Router } from 'express';
import type { BotManager } from '../bot/BotManager.js';
import { BacktestRunner } from '../backtest/BacktestRunner.js';
import { HistoricalDataFeed } from '../backtest/HistoricalDataFeed.js';
import type { BacktestRunConfig } from '../backtest/types.js';

export function registerBacktestRoutes(router: Router, botManager: BotManager) {
  router.post('/api/bots/:botId/backtest', async (req, res) => {
    try {
      const { botId } = req.params;
      const { startDate, endDate, initialBalance } = req.body;

      const bot = botManager.getBot(botId);
      if (!bot) {
        return res.status(404).json({ error: 'Bot not found' });
      }

      // Only SoDEX perp
      const exchange = 'exchange' in bot.config ? (bot.config as any).exchange : null;
      if (exchange !== 'sodex' || !('symbol' in bot.config) || !(bot.config as any).symbol?.includes('PERP')) {
        return res.status(400).json({
          error: 'Backtest only available for SoDEX perpetual futures'
        });
      }

      // Validate dates
      const start = new Date(startDate);
      const end = new Date(endDate);
      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        return res.status(400).json({ error: 'Invalid date format' });
      }
      if (end <= start) {
        return res.status(400).json({ error: 'End date must be after start date' });
      }

      // Max 30 days
      const daysDiff = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
      if (daysDiff > 30) {
        return res.status(400).json({ error: 'Max backtest period is 30 days' });
      }

      // Build config
      const config: BacktestRunConfig = {
        botId,
        from: start.toISOString().split('T')[0],
        to: end.toISOString().split('T')[0],
        interval: '5m',
        initialBalance: initialBalance || 1000,
        makerFeeBps: 12,  // SoDEX: 0.012%
        takerFeeBps: 30,
        slippageBps: 5,
        dataSource: 'exchange_api',
        fillMode: 'realistic'
      };

      // Run backtest
      const dataFeed = new HistoricalDataFeed();
      const runner = new BacktestRunner(config, dataFeed);
      const result = await runner.run();

      // Transform to simple format
      res.json({
        totalTrades: result.metrics.totalTrades,
        winRate: result.metrics.winRate,
        totalPnl: result.metrics.totalPnl,
        sharpeRatio: result.metrics.sharpeRatio,
        maxDrawdown: result.metrics.maxDrawdown,
        equityCurve: result.equityCurve.map(s => ({
          timestamp: s.timestamp,
          equity: s.equity
        })),
        byRegime: {}, // TODO: group trades by regime
        trades: result.trades.slice(0, 100).map(t => ({
          timestamp: t.exitTime,
          direction: t.side,
          entryPrice: t.entryPrice,
          exitPrice: t.exitPrice,
          pnl: t.netPnl,
          regime: 'UNKNOWN'
        }))
      });

    } catch (err: any) {
      console.error('[Backtest] Error:', err);
      res.status(500).json({ error: err.message });
    }
  });
}
