import axios from 'axios';

/**
 * Input context passed to the LLM for reasoning generation.
 */
export interface ReasoningContext {
  symbol: string;
  direction: 'long' | 'short' | 'skip';
  regime: string;
  rsi: number;
  ema9: number;
  ema21: number;
  momentumScore: number;
  pricePosition: number; // 0 = bottom of range, 1 = top
  volSpike: boolean;
  imbalance: number;
  tradePressure: number;
  currentPrice: number;
  confidence: number;
}

/**
 * LLMReasoningAgent — wraps a local Ollama instance (or any OpenAI-compatible
 * endpoint) to generate a human-readable "reasoning" sentence for each trade
 * decision made by AISignalEngine.
 *
 * Design goals:
 * - Non-blocking: if Ollama is unavailable or slow, falls back to the
 *   rule-based reasoning string from AISignalEngine within the timeout.
 * - Cheap: sends a compact prompt (~200 tokens) to keep latency low.
 * - Configurable: reads OLLAMA_URL and OLLAMA_MODEL from env.
 *
 * Usage:
 *   const agent = new LLMReasoningAgent();
 *   const reasoning = await agent.generateReasoning(ctx, fallbackReasoning);
 */
export class LLMReasoningAgent {
  private ollamaUrl: string;
  private model: string;
  private timeoutMs: number;

  /** Singleton — one instance shared across all signal engines */
  private static _instance: LLMReasoningAgent | null = null;

  static getInstance(): LLMReasoningAgent {
    if (!LLMReasoningAgent._instance) {
      LLMReasoningAgent._instance = new LLMReasoningAgent();
    }
    return LLMReasoningAgent._instance;
  }

  constructor(
    ollamaUrl = process.env.OLLAMA_URL ?? 'http://localhost:11434',
    model = process.env.OLLAMA_MODEL ?? 'llama3',
    timeoutMs = parseInt(process.env.LLM_REASONING_TIMEOUT_MS ?? '4000', 10),
  ) {
    this.ollamaUrl = ollamaUrl.replace(/\/$/, '');
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Generate a one-sentence reasoning string for a trade decision.
   *
   * Returns `fallback` immediately if:
   * - LLM_REASONING_ENABLED env is not 'true'
   * - Ollama is unreachable or times out
   * - The LLM returns an empty response
   *
   * @param ctx       - Technical indicators and decision context
   * @param fallback  - Rule-based reasoning string from AISignalEngine
   */
  async generateReasoning(ctx: ReasoningContext, fallback: string): Promise<string> {
    if (process.env.LLM_REASONING_ENABLED !== 'true') {
      return fallback;
    }

    const prompt = this._buildPrompt(ctx);

    try {
      const response = await axios.post(
        `${this.ollamaUrl}/api/generate`,
        {
          model: this.model,
          prompt,
          stream: false,
          options: {
            temperature: 0.4,
            num_predict: 80, // keep output short — one sentence
            stop: ['\n', '.'],
          },
        },
        { timeout: this.timeoutMs },
      );

      const text: string = response.data?.response?.trim() ?? '';
      if (!text) {
        console.warn('[LLMReasoningAgent] Empty response from Ollama — using fallback');
        return fallback;
      }

      // Ensure the sentence ends with a period
      const sentence = text.endsWith('.') ? text : `${text}.`;
      console.log(`[LLMReasoningAgent] ✅ ${sentence}`);
      return sentence;
    } catch (err: any) {
      // Timeout or connection refused — silent fallback, don't spam logs
      if (err?.code === 'ECONNREFUSED' || err?.code === 'ECONNRESET') {
        // Ollama not running — suppress repeated warnings after first
      } else if (err?.code === 'ECONNABORTED' || err?.message?.includes('timeout')) {
        console.warn(`[LLMReasoningAgent] Timeout (${this.timeoutMs}ms) — using fallback`);
      } else {
        console.warn('[LLMReasoningAgent] Error:', err?.message ?? err);
      }
      return fallback;
    }
  }

  /**
   * Build a compact prompt that fits in ~200 tokens.
   * Written in Vietnamese to match the project's language preference.
   */
  private _buildPrompt(ctx: ReasoningContext): string {
    const directionVi =
      ctx.direction === 'long' ? 'MỞ LONG' :
      ctx.direction === 'short' ? 'MỞ SHORT' : 'BỎ QUA';

    const regimeVi =
      ctx.regime === 'TREND_UP' ? 'xu hướng tăng' :
      ctx.regime === 'TREND_DOWN' ? 'xu hướng giảm' :
      ctx.regime === 'SIDEWAY' ? 'đi ngang' : 'biến động cao';

    const rsiStatus =
      ctx.rsi < 35 ? 'quá bán' :
      ctx.rsi > 65 ? 'quá mua' : 'trung tính';

    const pricePos = (ctx.pricePosition * 100).toFixed(0);
    const emaSignal = ctx.ema9 > ctx.ema21 ? 'EMA9 trên EMA21 (bullish)' : 'EMA9 dưới EMA21 (bearish)';
    const volText = ctx.volSpike ? 'có spike khối lượng' : 'khối lượng bình thường';
    const confPct = (ctx.confidence * 100).toFixed(0);

    return (
      `Bạn là AI trading agent. Hãy viết MỘT câu ngắn (tối đa 25 từ) giải thích quyết định giao dịch sau bằng tiếng Việt tự nhiên.\n\n` +
      `Quyết định: ${directionVi} ${ctx.symbol} @ $${ctx.currentPrice.toFixed(2)}\n` +
      `Thị trường: ${regimeVi}\n` +
      `RSI=${ctx.rsi.toFixed(1)} (${rsiStatus}), ${emaSignal}\n` +
      `Giá ở vị trí ${pricePos}% trong range, ${volText}\n` +
      `Momentum score=${ctx.momentumScore.toFixed(2)}, Confidence=${confPct}%\n\n` +
      `Câu giải thích (bắt đầu bằng "Dựa trên" hoặc "Với"):`
    );
  }
}
