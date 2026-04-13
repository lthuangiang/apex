import { Router, type Request, type Response } from 'express';
import { TradingMemoryService } from './TradingMemoryService.js';
import type { MemorySignal, PnLResult, TradeDecision } from './types.js';

const router = Router();
const memoryService = new TradingMemoryService();

router.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

router.post('/save', async (req: Request, res: Response) => {
  const { signal, decision, pnlResult } = req.body as {
    signal?: MemorySignal;
    decision?: TradeDecision;
    pnlResult?: PnLResult;
  };

  if (!signal || !decision || !pnlResult) {
    res.status(400).json({ error: 'Missing required fields: signal, decision, pnlResult' });
    return;
  }

  const requiredSignalFields: (keyof MemorySignal)[] = ['price', 'sma50', 'ls_ratio', 'orderbook_imbalance', 'buy_pressure', 'rsi'];
  for (const field of requiredSignalFields) {
    if (typeof signal[field] !== 'number') {
      res.status(400).json({ error: `signal.${field} must be a number` });
      return;
    }
  }

  try {
    const tradeId = await memoryService.saveTrade(signal, decision, pnlResult);
    res.json({ tradeId, status: 'saved' });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

router.post('/predict', async (req: Request, res: Response) => {
  const { signal } = req.body as { signal?: MemorySignal };

  if (!signal) {
    res.status(400).json({ error: 'Missing required field: signal' });
    return;
  }

  const requiredSignalFields: (keyof MemorySignal)[] = ['price', 'sma50', 'ls_ratio', 'orderbook_imbalance', 'buy_pressure', 'rsi'];
  for (const field of requiredSignalFields) {
    if (typeof signal[field] !== 'number') {
      res.status(400).json({ error: `signal.${field} must be a number` });
      return;
    }
  }

  const result = await memoryService.predict(signal);
  res.json(result);
});

export { router as memoryRouter };
