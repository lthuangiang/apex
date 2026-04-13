import axios from 'axios';

export interface LLMDecision {
  direction: 'long' | 'short' | 'skip';
  confidence: number; // clamped to [0, 1] before return
  reasoning: string;
}

export interface MarketContext {
  sma50: number;
  currentPrice: number;
  lsRatio: number;
  imbalance: number;
  tradePressure: number;
  fearGreedIndex: number | null;
  fearGreedLabel: string | null;
  sectorIndex: number | null;
}

export class LLMClient {
  private provider: 'openai' | 'anthropic';
  private apiKey: string;

  constructor(provider: 'openai' | 'anthropic', apiKey: string) {
    this.provider = provider;
    this.apiKey = apiKey;
  }

  buildPrompt(ctx: MarketContext): string {
    const smaTrend = ctx.currentPrice >= ctx.sma50 ? 'above' : 'below';
    const extra = ctx as any;

    const pricePos = extra.pricePositionInRange !== undefined
        ? `\n- Price in 10-candle range: ${(extra.pricePositionInRange * 100).toFixed(0)}% (0%=range bottom, 100%=range top)`
        : '';

    const technicalLines = extra.ema9 !== undefined ? `
- EMA9: ${extra.ema9?.toFixed(2)}, EMA21 (SMA): ${ctx.sma50?.toFixed(2)} → price ${smaTrend} EMA21
- RSI(14): ${extra.rsi?.toFixed(1)} ${extra.rsi < 35 ? '(OVERSOLD)' : extra.rsi > 65 ? '(OVERBOUGHT)' : '(neutral)'}
- 3-candle momentum: ${((extra.momentum3candles ?? 0) * 100).toFixed(3)}%
- Volume spike: ${extra.volSpike ? 'YES' : 'no'}
- EMA cross: ${extra.emaCrossUp ? 'BULLISH CROSS ↑' : extra.emaCrossDown ? 'BEARISH CROSS ↓' : 'none'}
- Regime: ${extra.regime ?? 'SIDEWAY'}${pricePos}` : `- SMA(50): ${ctx.sma50}, Current Price: ${ctx.currentPrice} → ${smaTrend} SMA`;

    return `You are a crypto scalping AI for 2-5 minute farm trades on BTC.

Market Data (5m chart):${technicalLines}
- L/S Ratio: ${ctx.lsRatio} (crowd sentiment)
- Orderbook Imbalance (bid/ask): ${ctx.imbalance?.toFixed(3)}
- Trade Pressure (buy%): ${(ctx.tradePressure * 100)?.toFixed(1)}%
- Round-trip fee: ${((extra.feeRoundTrip ?? 0.00024) * 100).toFixed(4)}% (must profit above this)

Strategy: MOMENTUM scalping for volume farming.
- Follow the short-term trend (EMA9 vs EMA21)
- Enter on momentum confirmation, not reversals
- In SIDEWAY: prefer LONG when price is near range bottom (<30%), prefer SHORT when near top (>70%)
- Avoid entering against the range: do NOT long when price >75% of range, do NOT short when <25%
- In SIDEWAY: pick direction with strongest immediate signal
- Only SKIP if signals are completely mixed with no edge
- Fee is 0.024% round-trip — need clear momentum to profit

Respond ONLY with valid JSON: {"direction": "long"|"short"|"skip", "confidence": 0.0-1.0, "reasoning": "one sentence"}`;
  }

  async call(ctx: MarketContext): Promise<LLMDecision | null> {
    const result = await this.callWithRaw(ctx);
    return result.decision;
  }

  async callWithRaw(ctx: MarketContext): Promise<{ decision: LLMDecision | null; raw: string | null }> {
    const prompt = this.buildPrompt(ctx);

    try {
      let content: string;

      if (this.provider === 'openai') {
        const res = await axios.post(
          'https://api.jso.vn/v1/chat/completions',
          {
            model: 'gpt-4o',
            messages: [{ role: 'user', content: prompt }],
          },
          {
            timeout: 15000,
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json',
            },
          }
        );
        content = res.data?.choices?.[0]?.message?.content;
        if (!content) {
          console.error('[LLMClient] OpenAI response missing content:', JSON.stringify(res.data).slice(0, 300));
          return { decision: null, raw: null };
        }
      } else {
        const res = await axios.post(
          'https://api-v2.shopaikey.com/v1/messages',
          {
            model: 'claude-sonnet-4-6',
            max_tokens: 256,
            messages: [{ role: 'user', content: prompt }],
          },
          {
            timeout: 15000,
            headers: {
              'x-api-key': this.apiKey,
              'anthropic-version': '2023-06-01',
              'Content-Type': 'application/json',
            },
          }
        );
        content = res.data?.content?.[0]?.text;
        if (!content) {
          console.error('[LLMClient] Anthropic response missing content:', JSON.stringify(res.data).slice(0, 300));
          return { decision: null, raw: null };
        }
      }

      const raw = content.trim();
      const jsonStr = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

      const parsed = JSON.parse(jsonStr) as {
        direction: 'long' | 'short' | 'skip';
        confidence: number;
        reasoning: string;
      };

      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        !['long', 'short', 'skip'].includes(parsed.direction) ||
        typeof parsed.confidence !== 'number' ||
        typeof parsed.reasoning !== 'string'
      ) {
        console.error('[LLMClient] Response missing required fields:', parsed);
        return { decision: null, raw };
      }

      const decision: LLMDecision = {
        direction: parsed.direction,
        confidence: Math.min(1, Math.max(0, parsed.confidence)),
        reasoning: parsed.reasoning,
      };

      return { decision, raw };
    } catch (err) {
      console.error('[LLMClient] call error:', err);
      return { decision: null, raw: null };
    }
  }
}
