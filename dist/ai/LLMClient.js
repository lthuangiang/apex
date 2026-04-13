"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LLMClient = void 0;
const axios_1 = __importDefault(require("axios"));
class LLMClient {
    provider;
    apiKey;
    constructor(provider, apiKey) {
        this.provider = provider;
        this.apiKey = apiKey;
    }
    buildPrompt(ctx) {
        const smaTrend = ctx.currentPrice >= ctx.sma50 ? 'above' : 'below';
        const sosoLines = ctx.fearGreedIndex === null || ctx.fearGreedLabel === null || ctx.sectorIndex === null
            ? '- SoSoValue data: unavailable'
            : `- SoSoValue Fear/Greed: ${ctx.fearGreedIndex} (${ctx.fearGreedLabel})\n- SoSoValue Sector Index: ${ctx.sectorIndex}`;
        return `You are a crypto trading AI. Given the following market data, decide whether to LONG, SHORT, or SKIP trading BTC.

Market Data:
- SMA(50): ${ctx.sma50}, Current Price: ${ctx.currentPrice} → ${smaTrend} SMA
- L/S Ratio: ${ctx.lsRatio} (crowd sentiment)
- Orderbook Imbalance: ${ctx.imbalance}
- Trade Pressure (buy%): ${ctx.tradePressure}
${sosoLines}

Strategy: Contrarian — fade crowd extremes, buy oversold, sell overbought.

Respond ONLY with valid JSON: {"direction": "long"|"short"|"skip", "confidence": 0.0-1.0, "reasoning": "one sentence"}`;
    }
    async call(ctx) {
        const result = await this.callWithRaw(ctx);
        return result.decision;
    }
    async callWithRaw(ctx) {
        const prompt = this.buildPrompt(ctx);
        try {
            let content;
            if (this.provider === 'openai') {
                const res = await axios_1.default.post('https://api.jso.vn/v1/chat/completions', {
                    model: 'gpt-4o',
                    messages: [{ role: 'user', content: prompt }],
                }, {
                    timeout: 15000,
                    headers: {
                        Authorization: `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json',
                    },
                });
                content = res.data.choices[0].message.content;
            }
            else {
                const res = await axios_1.default.post('https://api-v2.shopaikey.com/v1/messages', {
                    model: 'claude-sonnet-4-6',
                    max_tokens: 256,
                    messages: [{ role: 'user', content: prompt }],
                }, {
                    timeout: 15000,
                    headers: {
                        'x-api-key': this.apiKey,
                        'anthropic-version': '2023-06-01',
                        'Content-Type': 'application/json',
                    },
                });
                content = res.data.content[0].text;
            }
            const raw = content.trim();
            const jsonStr = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
            const parsed = JSON.parse(jsonStr);
            if (parsed === null ||
                typeof parsed !== 'object' ||
                !['long', 'short', 'skip'].includes(parsed.direction) ||
                typeof parsed.confidence !== 'number' ||
                typeof parsed.reasoning !== 'string') {
                console.error('[LLMClient] Response missing required fields:', parsed);
                return { decision: null, raw };
            }
            const decision = {
                direction: parsed.direction,
                confidence: Math.min(1, Math.max(0, parsed.confidence)),
                reasoning: parsed.reasoning,
            };
            return { decision, raw };
        }
        catch (err) {
            console.error('[LLMClient] call error:', err);
            return { decision: null, raw: null };
        }
    }
}
exports.LLMClient = LLMClient;
