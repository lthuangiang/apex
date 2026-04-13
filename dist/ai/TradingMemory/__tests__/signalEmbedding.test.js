"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const signalEmbedding_js_1 = require("../signalEmbedding.js");
const baseSignal = {
    price: 42500,
    sma50: 41800,
    ls_ratio: 0.62,
    orderbook_imbalance: 0.55,
    buy_pressure: 0.70,
    rsi: 58.3,
};
// ── signalToEmbedding ────────────────────────────────────────────────────────
(0, vitest_1.describe)('signalToEmbedding', () => {
    (0, vitest_1.it)('returns array of length 6', () => {
        (0, vitest_1.expect)((0, signalEmbedding_js_1.signalToEmbedding)(baseSignal)).toHaveLength(6);
    });
    (0, vitest_1.it)('all values are in [0, 1]', () => {
        const emb = (0, signalEmbedding_js_1.signalToEmbedding)(baseSignal);
        for (const v of emb) {
            (0, vitest_1.expect)(v).toBeGreaterThanOrEqual(0);
            (0, vitest_1.expect)(v).toBeLessThanOrEqual(1);
        }
    });
    (0, vitest_1.it)('is deterministic', () => {
        (0, vitest_1.expect)((0, signalEmbedding_js_1.signalToEmbedding)(baseSignal)).toEqual((0, signalEmbedding_js_1.signalToEmbedding)(baseSignal));
    });
    (0, vitest_1.it)('computes known values correctly', () => {
        const emb = (0, signalEmbedding_js_1.signalToEmbedding)(baseSignal);
        const priceNorm = 42500 / (42500 + 41800);
        const sma50Norm = 41800 / (42500 + 41800);
        const rsiNorm = 58.3 / 100;
        (0, vitest_1.expect)(emb[0]).toBeCloseTo(priceNorm);
        (0, vitest_1.expect)(emb[1]).toBeCloseTo(sma50Norm);
        (0, vitest_1.expect)(emb[2]).toBeCloseTo(0.62);
        (0, vitest_1.expect)(emb[3]).toBeCloseTo(0.55);
        (0, vitest_1.expect)(emb[4]).toBeCloseTo(0.70);
        (0, vitest_1.expect)(emb[5]).toBeCloseTo(rsiNorm);
    });
});
// ── buildPrompt ──────────────────────────────────────────────────────────────
(0, vitest_1.describe)('buildPrompt', () => {
    (0, vitest_1.it)('contains all signal field values', () => {
        const prompt = (0, signalEmbedding_js_1.buildPrompt)(baseSignal, []);
        (0, vitest_1.expect)(prompt).toContain('42500');
        (0, vitest_1.expect)(prompt).toContain('41800');
        (0, vitest_1.expect)(prompt).toContain('0.62');
        (0, vitest_1.expect)(prompt).toContain('0.55');
        (0, vitest_1.expect)(prompt).toContain('0.7');
        (0, vitest_1.expect)(prompt).toContain('58.3');
    });
    (0, vitest_1.it)('contains trade outcomes when similar trades provided', () => {
        const trade = {
            tradeId: 'abc',
            signal: baseSignal,
            decision: 'long',
            pnlPercent: 2.1,
            outcome: 'WIN',
            timestamp: '2024-01-01T00:00:00.000Z',
        };
        const prompt = (0, signalEmbedding_js_1.buildPrompt)(baseSignal, [trade]);
        (0, vitest_1.expect)(prompt).toContain('WIN');
        (0, vitest_1.expect)(prompt).toContain('long');
        (0, vitest_1.expect)(prompt).toContain('2.1');
    });
    (0, vitest_1.it)('handles empty similar trades gracefully', () => {
        const prompt = (0, signalEmbedding_js_1.buildPrompt)(baseSignal, []);
        (0, vitest_1.expect)(prompt).toContain('No historical trades available yet');
    });
    (0, vitest_1.it)('instructs LLM to return JSON with required keys', () => {
        const prompt = (0, signalEmbedding_js_1.buildPrompt)(baseSignal, []);
        (0, vitest_1.expect)(prompt).toContain('direction');
        (0, vitest_1.expect)(prompt).toContain('confidence');
        (0, vitest_1.expect)(prompt).toContain('reasoning');
    });
});
// ── parseLLMResponse ─────────────────────────────────────────────────────────
(0, vitest_1.describe)('parseLLMResponse', () => {
    (0, vitest_1.it)('parses valid JSON', () => {
        const raw = '{"direction": "long", "confidence": 0.8, "reasoning": "strong signal"}';
        const result = (0, signalEmbedding_js_1.parseLLMResponse)(raw, 0.7);
        (0, vitest_1.expect)(result.direction).toBe('long');
        (0, vitest_1.expect)(result.confidence).toBeCloseTo(0.8);
        (0, vitest_1.expect)(result.reasoning).toBe('strong signal');
        (0, vitest_1.expect)(result.winRateOfSimilar).toBeCloseTo(0.7);
    });
    (0, vitest_1.it)('extracts JSON embedded in prose', () => {
        const raw = 'Based on analysis: {"direction": "short", "confidence": 0.6, "reasoning": "overbought"} end.';
        const result = (0, signalEmbedding_js_1.parseLLMResponse)(raw, 0.3);
        (0, vitest_1.expect)(result.direction).toBe('short');
        (0, vitest_1.expect)(result.confidence).toBeCloseTo(0.6);
    });
    (0, vitest_1.it)('returns skip fallback for empty string', () => {
        const result = (0, signalEmbedding_js_1.parseLLMResponse)('', 0.5);
        (0, vitest_1.expect)(result.direction).toBe('skip');
        (0, vitest_1.expect)(result.confidence).toBe(0);
        (0, vitest_1.expect)(result.reasoning).toBe('parse_error');
    });
    (0, vitest_1.it)('returns skip fallback for garbage input', () => {
        const result = (0, signalEmbedding_js_1.parseLLMResponse)('not json at all!!!', 0.5);
        (0, vitest_1.expect)(result.direction).toBe('skip');
    });
    (0, vitest_1.it)('clamps confidence above 1.0', () => {
        const raw = '{"direction": "long", "confidence": 1.5, "reasoning": "test"}';
        const result = (0, signalEmbedding_js_1.parseLLMResponse)(raw, 0);
        (0, vitest_1.expect)(result.confidence).toBeLessThanOrEqual(1.0);
    });
    (0, vitest_1.it)('clamps confidence below 0.0', () => {
        const raw = '{"direction": "long", "confidence": -0.5, "reasoning": "test"}';
        const result = (0, signalEmbedding_js_1.parseLLMResponse)(raw, 0);
        (0, vitest_1.expect)(result.confidence).toBeGreaterThanOrEqual(0.0);
    });
    (0, vitest_1.it)('never throws for any string input', () => {
        const inputs = ['', '{}', 'null', '[]', '{"direction": "invalid"}', 'random text'];
        for (const input of inputs) {
            (0, vitest_1.expect)(() => (0, signalEmbedding_js_1.parseLLMResponse)(input, 0)).not.toThrow();
        }
    });
});
