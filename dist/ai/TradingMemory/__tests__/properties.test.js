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
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const fc = __importStar(require("fast-check"));
const signalEmbedding_js_1 = require("../signalEmbedding.js");
// Arbitrary for valid MemorySignal
const signalArb = fc.record({
    price: fc.float({ min: 1, max: 1_000_000, noNaN: true }),
    sma50: fc.float({ min: 1, max: 1_000_000, noNaN: true }),
    ls_ratio: fc.float({ min: 0, max: 1, noNaN: true }),
    orderbook_imbalance: fc.float({ min: 0, max: 1, noNaN: true }),
    buy_pressure: fc.float({ min: 0, max: 1, noNaN: true }),
    rsi: fc.float({ min: 0, max: 100, noNaN: true }),
});
(0, vitest_1.describe)('Property: signalToEmbedding', () => {
    (0, vitest_1.it)('always returns 6 floats in [0, 1]', () => {
        fc.assert(fc.property(signalArb, (signal) => {
            const emb = (0, signalEmbedding_js_1.signalToEmbedding)(signal);
            (0, vitest_1.expect)(emb).toHaveLength(6);
            for (const v of emb) {
                (0, vitest_1.expect)(v).toBeGreaterThanOrEqual(0);
                (0, vitest_1.expect)(v).toBeLessThanOrEqual(1);
                (0, vitest_1.expect)(Number.isFinite(v)).toBe(true);
            }
        }));
    });
    (0, vitest_1.it)('is deterministic for any signal', () => {
        fc.assert(fc.property(signalArb, (signal) => {
            (0, vitest_1.expect)((0, signalEmbedding_js_1.signalToEmbedding)(signal)).toEqual((0, signalEmbedding_js_1.signalToEmbedding)(signal));
        }));
    });
});
(0, vitest_1.describe)('Property: parseLLMResponse', () => {
    (0, vitest_1.it)('never throws for any string input', () => {
        fc.assert(fc.property(fc.string(), fc.float({ min: 0, max: 1, noNaN: true }), (raw, winRate) => {
            (0, vitest_1.expect)(() => (0, signalEmbedding_js_1.parseLLMResponse)(raw, winRate)).not.toThrow();
        }));
    });
    (0, vitest_1.it)('always returns a valid direction', () => {
        fc.assert(fc.property(fc.string(), fc.float({ min: 0, max: 1, noNaN: true }), (raw, winRate) => {
            const result = (0, signalEmbedding_js_1.parseLLMResponse)(raw, winRate);
            (0, vitest_1.expect)(['long', 'short', 'skip']).toContain(result.direction);
        }));
    });
    (0, vitest_1.it)('always returns confidence in [0, 1]', () => {
        fc.assert(fc.property(fc.string(), fc.float({ min: 0, max: 1, noNaN: true }), (raw, winRate) => {
            const result = (0, signalEmbedding_js_1.parseLLMResponse)(raw, winRate);
            (0, vitest_1.expect)(result.confidence).toBeGreaterThanOrEqual(0);
            (0, vitest_1.expect)(result.confidence).toBeLessThanOrEqual(1);
        }));
    });
    (0, vitest_1.it)('winRateOfSimilar always equals the passed-in value', () => {
        fc.assert(fc.property(fc.string(), fc.float({ min: 0, max: 1, noNaN: true }), (raw, winRate) => {
            const result = (0, signalEmbedding_js_1.parseLLMResponse)(raw, winRate);
            (0, vitest_1.expect)(result.winRateOfSimilar).toBeCloseTo(winRate);
        }));
    });
});
