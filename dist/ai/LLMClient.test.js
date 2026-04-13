"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// Feature: ai-alpha-execution-engine, Property 2: LLM prompt always contains all market data fields
// Feature: ai-alpha-execution-engine, Property 3: LLM confidence is always clamped to [0, 1]
const vitest_1 = require("vitest");
const fc = __importStar(require("fast-check"));
const axios_1 = __importDefault(require("axios"));
vitest_1.vi.mock('axios');
const mockedAxios = axios_1.default;
const LLMClient_js_1 = require("./LLMClient.js");
(0, vitest_1.describe)('LLMClient', () => {
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.clearAllMocks();
    });
    // **Validates: Requirements 2.1**
    // Property 2: LLM prompt always contains all market data fields
    (0, vitest_1.it)('P2: prompt always contains all market data fields for any valid MarketContext', () => {
        fc.assert(fc.property(fc.record({
            sma50: fc.float({ noNaN: true }),
            currentPrice: fc.float({ noNaN: true }),
            lsRatio: fc.float({ noNaN: true }),
            imbalance: fc.float({ noNaN: true }),
            tradePressure: fc.float({ noNaN: true }),
            fearGreedIndex: fc.option(fc.float({ noNaN: true })),
            fearGreedLabel: fc.option(fc.string()),
            sectorIndex: fc.option(fc.float({ noNaN: true })),
        }), (ctx) => {
            // fc.option returns null when not present
            const marketCtx = {
                ...ctx,
                fearGreedIndex: ctx.fearGreedIndex ?? null,
                fearGreedLabel: ctx.fearGreedLabel ?? null,
                sectorIndex: ctx.sectorIndex ?? null,
            };
            const client = new LLMClient_js_1.LLMClient('openai', 'test-key');
            const prompt = client.buildPrompt(marketCtx);
            (0, vitest_1.expect)(prompt).toContain(String(marketCtx.sma50));
            (0, vitest_1.expect)(prompt).toContain(String(marketCtx.currentPrice));
            (0, vitest_1.expect)(prompt).toContain(String(marketCtx.lsRatio));
            (0, vitest_1.expect)(prompt).toContain(String(marketCtx.imbalance));
            (0, vitest_1.expect)(prompt).toContain(String(marketCtx.tradePressure));
        }), { numRuns: 100 });
    });
    (0, vitest_1.it)('prompt contains SoSoValue unavailable text when any SoSoValue field is null', () => {
        const client = new LLMClient_js_1.LLMClient('openai', 'test-key');
        const ctx = {
            sma50: 50000,
            currentPrice: 51000,
            lsRatio: 1.2,
            imbalance: 0.05,
            tradePressure: 0.6,
            fearGreedIndex: null,
            fearGreedLabel: null,
            sectorIndex: null,
        };
        const prompt = client.buildPrompt(ctx);
        (0, vitest_1.expect)(prompt).toContain('- SoSoValue data: unavailable');
        (0, vitest_1.expect)(prompt).not.toContain('Fear/Greed');
        (0, vitest_1.expect)(prompt).not.toContain('Sector Index');
    });
    (0, vitest_1.it)('prompt contains SoSoValue data when all fields are present', () => {
        const client = new LLMClient_js_1.LLMClient('openai', 'test-key');
        const ctx = {
            sma50: 50000,
            currentPrice: 51000,
            lsRatio: 1.2,
            imbalance: 0.05,
            tradePressure: 0.6,
            fearGreedIndex: 72,
            fearGreedLabel: 'Greed',
            sectorIndex: 105,
        };
        const prompt = client.buildPrompt(ctx);
        (0, vitest_1.expect)(prompt).toContain('72');
        (0, vitest_1.expect)(prompt).toContain('Greed');
        (0, vitest_1.expect)(prompt).toContain('105');
        (0, vitest_1.expect)(prompt).not.toContain('unavailable');
    });
    // **Validates: Requirements 2.3**
    // Property 3: LLM confidence is always clamped to [0, 1]
    (0, vitest_1.it)('P3: confidence is always clamped to [0, 1] for any raw LLM confidence value', async () => {
        await fc.assert(fc.asyncProperty(fc.float({ min: -10, max: 10, noNaN: true }), async (rawConfidence) => {
            const llmResponse = JSON.stringify({
                direction: 'long',
                confidence: rawConfidence,
                reasoning: 'test reasoning',
            });
            mockedAxios.post = vitest_1.vi.fn().mockResolvedValue({
                data: {
                    choices: [{ message: { content: llmResponse } }],
                },
            });
            const client = new LLMClient_js_1.LLMClient('openai', 'test-key');
            const ctx = {
                sma50: 50000,
                currentPrice: 51000,
                lsRatio: 1.2,
                imbalance: 0.05,
                tradePressure: 0.6,
                fearGreedIndex: null,
                fearGreedLabel: null,
                sectorIndex: null,
            };
            const result = await client.call(ctx);
            (0, vitest_1.expect)(result).not.toBeNull();
            (0, vitest_1.expect)(result.confidence).toBeGreaterThanOrEqual(0);
            (0, vitest_1.expect)(result.confidence).toBeLessThanOrEqual(1);
        }), { numRuns: 100 });
    });
    (0, vitest_1.it)('returns null on network error', async () => {
        mockedAxios.post = vitest_1.vi.fn().mockRejectedValue(new Error('Network Error'));
        const client = new LLMClient_js_1.LLMClient('openai', 'test-key');
        const ctx = {
            sma50: 50000,
            currentPrice: 51000,
            lsRatio: 1.2,
            imbalance: 0.05,
            tradePressure: 0.6,
            fearGreedIndex: null,
            fearGreedLabel: null,
            sectorIndex: null,
        };
        const result = await client.call(ctx);
        (0, vitest_1.expect)(result).toBeNull();
    });
    (0, vitest_1.it)('returns null on JSON parse failure', async () => {
        mockedAxios.post = vitest_1.vi.fn().mockResolvedValue({
            data: { choices: [{ message: { content: 'not valid json {{' } }] },
        });
        const client = new LLMClient_js_1.LLMClient('openai', 'test-key');
        const ctx = {
            sma50: 50000,
            currentPrice: 51000,
            lsRatio: 1.2,
            imbalance: 0.05,
            tradePressure: 0.6,
            fearGreedIndex: null,
            fearGreedLabel: null,
            sectorIndex: null,
        };
        const result = await client.call(ctx);
        (0, vitest_1.expect)(result).toBeNull();
    });
    (0, vitest_1.it)('uses anthropic endpoint and extracts content[0].text', async () => {
        const llmResponse = JSON.stringify({
            direction: 'short',
            confidence: 0.8,
            reasoning: 'bearish signal',
        });
        mockedAxios.post = vitest_1.vi.fn().mockResolvedValue({
            data: { content: [{ text: llmResponse }] },
        });
        const client = new LLMClient_js_1.LLMClient('anthropic', 'test-key');
        const ctx = {
            sma50: 50000,
            currentPrice: 49000,
            lsRatio: 0.8,
            imbalance: -0.1,
            tradePressure: 0.4,
            fearGreedIndex: null,
            fearGreedLabel: null,
            sectorIndex: null,
        };
        const result = await client.call(ctx);
        (0, vitest_1.expect)(result).not.toBeNull();
        (0, vitest_1.expect)(result.direction).toBe('short');
        (0, vitest_1.expect)(result.confidence).toBe(0.8);
        (0, vitest_1.expect)(mockedAxios.post).toHaveBeenCalledWith('https://api.anthropic.com/v1/messages', vitest_1.expect.any(Object), vitest_1.expect.objectContaining({
            headers: vitest_1.expect.objectContaining({ 'anthropic-version': '2023-06-01' }),
        }));
    });
});
