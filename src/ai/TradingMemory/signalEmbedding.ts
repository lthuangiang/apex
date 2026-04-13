import type { MemorySignal, TradeRecord, PredictionResult } from './types.js';

/**
 * Convert a MemorySignal into a 6-element normalized float vector for ChromaDB.
 * Order: [priceNorm, sma50Norm, ls_ratio, orderbook_imbalance, buy_pressure, rsiNorm]
 */
export function signalToEmbedding(signal: MemorySignal): number[] {
  const priceNorm = signal.price / (signal.price + signal.sma50);
  const sma50Norm = signal.sma50 / (signal.price + signal.sma50);
  const rsiNorm = signal.rsi / 100;

  return [
    clamp(priceNorm, 0, 1),
    clamp(sma50Norm, 0, 1),
    clamp(signal.ls_ratio, 0, 1),
    clamp(signal.orderbook_imbalance, 0, 1),
    clamp(signal.buy_pressure, 0, 1),
    clamp(rsiNorm, 0, 1),
  ];
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

/**
 * Build the LLM prompt from current signal + historical similar trades.
 */
export function buildPrompt(signal: MemorySignal, similarTrades: TradeRecord[]): string {
  const signalStr = [
    `price=${signal.price}`,
    `sma50=${signal.sma50}`,
    `ls_ratio=${signal.ls_ratio}`,
    `orderbook_imbalance=${signal.orderbook_imbalance}`,
    `buy_pressure=${signal.buy_pressure}`,
    `rsi=${signal.rsi}`,
  ].join(', ');

  let historySection = '';
  if (similarTrades.length === 0) {
    historySection = 'No historical trades available yet.';
  } else {
    historySection = similarTrades.map((t, i) => {
      const s = t.signal;
      return `Trade ${i + 1}: price=${s.price}, sma50=${s.sma50}, ls_ratio=${s.ls_ratio}, ` +
        `orderbook_imbalance=${s.orderbook_imbalance}, buy_pressure=${s.buy_pressure}, rsi=${s.rsi} ` +
        `→ decision=${t.decision}, pnl=${t.pnlPercent}%, outcome=${t.outcome}`;
    }).join('\n');
  }

  return `You are a crypto trading assistant. Based on the current market signal and similar historical trades, decide whether to go LONG, SHORT, or SKIP.

Current signal:
${signalStr}

Similar historical trades:
${historySection}

Respond ONLY with a JSON object in this exact format (no extra text):
{"direction": "long"|"short"|"skip", "confidence": 0.0-1.0, "reasoning": "brief explanation"}`;
}

/**
 * Extract and validate JSON from LLM output. Never throws.
 */
export function parseLLMResponse(raw: string, winRateOfSimilar: number): PredictionResult {
  const fallback: PredictionResult = {
    direction: 'skip',
    confidence: 0,
    reasoning: 'parse_error',
    winRateOfSimilar,
  };

  try {
    // Extract first JSON object from raw text
    const match = raw.match(/\{[\s\S]*?\}/);
    if (!match) return fallback;

    const parsed = JSON.parse(match[0]) as Record<string, unknown>;

    const direction = parsed['direction'];
    if (direction !== 'long' && direction !== 'short' && direction !== 'skip') return fallback;

    const rawConf = typeof parsed['confidence'] === 'number' ? parsed['confidence'] : parseFloat(String(parsed['confidence']));
    const confidence = isNaN(rawConf) ? 0 : Math.min(Math.max(rawConf, 0), 1);

    const reasoning = typeof parsed['reasoning'] === 'string' ? parsed['reasoning'] : '';

    return { direction, confidence, reasoning, winRateOfSimilar };
  } catch {
    return fallback;
  }
}
