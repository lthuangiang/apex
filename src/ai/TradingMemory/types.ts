export type TradeDecision = 'long' | 'short' | 'skip';

export interface MemorySignal {
  price: number;
  sma50: number;
  ls_ratio: number;
  orderbook_imbalance: number;
  buy_pressure: number;
  rsi: number;
}

export interface PnLResult {
  pnlPercent: number;
  outcome: 'WIN' | 'LOSS';
}

export interface TradeRecord {
  tradeId: string;
  signal: MemorySignal;
  decision: TradeDecision;
  pnlPercent: number;
  outcome: 'WIN' | 'LOSS';
  timestamp: string;
}

export interface PredictionResult {
  direction: TradeDecision;
  confidence: number;
  reasoning: string;
  winRateOfSimilar: number;
}
