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
// Feature: ai-alpha-execution-engine, Property 1: SoSoValue response always yields a complete structured object
const vitest_1 = require("vitest");
const fc = __importStar(require("fast-check"));
const axios_1 = __importDefault(require("axios"));
vitest_1.vi.mock('axios');
const mockedAxios = axios_1.default;
const SoSoValueClient_js_1 = require("./SoSoValueClient.js");
(0, vitest_1.describe)('SoSoValueClient', () => {
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.clearAllMocks();
    });
    // Unit tests
    (0, vitest_1.it)('returns null on network error', async () => {
        mockedAxios.get = vitest_1.vi.fn().mockRejectedValue(new Error('Network Error'));
        const client = new SoSoValueClient_js_1.SoSoValueClient();
        const result = await client.fetch();
        (0, vitest_1.expect)(result).toBeNull();
    });
    (0, vitest_1.it)('returns null on timeout', async () => {
        const err = Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
        mockedAxios.get = vitest_1.vi.fn().mockRejectedValue(err);
        const client = new SoSoValueClient_js_1.SoSoValueClient();
        const result = await client.fetch();
        (0, vitest_1.expect)(result).toBeNull();
    });
    (0, vitest_1.it)('returns null when response fields are missing/NaN', async () => {
        mockedAxios.get = vitest_1.vi.fn().mockResolvedValue({ data: { unrelated: 'field' } });
        const client = new SoSoValueClient_js_1.SoSoValueClient();
        const result = await client.fetch();
        (0, vitest_1.expect)(result).toBeNull();
    });
    (0, vitest_1.it)('returns correct fields on a valid response', async () => {
        mockedAxios.get = vitest_1.vi.fn().mockResolvedValue({
            data: { sectorIndex: 42, fearGreedIndex: 75, fearGreedLabel: 'Greed' },
        });
        const client = new SoSoValueClient_js_1.SoSoValueClient();
        const result = await client.fetch();
        (0, vitest_1.expect)(result).toEqual({ sectorIndex: 42, fearGreedIndex: 75, fearGreedLabel: 'Greed' });
    });
    (0, vitest_1.it)('attaches Authorization header when SOSOVALUE_API_KEY is set', async () => {
        process.env.SOSOVALUE_API_KEY = 'test-key-123';
        mockedAxios.get = vitest_1.vi.fn().mockResolvedValue({
            data: { sectorIndex: 1, fearGreedIndex: 50, fearGreedLabel: 'Neutral' },
        });
        const client = new SoSoValueClient_js_1.SoSoValueClient();
        await client.fetch();
        (0, vitest_1.expect)(mockedAxios.get).toHaveBeenCalledWith(vitest_1.expect.any(String), vitest_1.expect.objectContaining({
            headers: vitest_1.expect.objectContaining({ Authorization: 'Bearer test-key-123' }),
        }));
        delete process.env.SOSOVALUE_API_KEY;
    });
    (0, vitest_1.it)('does not attach Authorization header when SOSOVALUE_API_KEY is absent', async () => {
        delete process.env.SOSOVALUE_API_KEY;
        mockedAxios.get = vitest_1.vi.fn().mockResolvedValue({
            data: { sectorIndex: 1, fearGreedIndex: 50, fearGreedLabel: 'Neutral' },
        });
        const client = new SoSoValueClient_js_1.SoSoValueClient();
        await client.fetch();
        const callArgs = mockedAxios.get.mock.calls[0][1];
        (0, vitest_1.expect)(callArgs.headers?.Authorization).toBeUndefined();
    });
    // **Validates: Requirements 1.2**
    // Property 1: SoSoValue response always yields a complete structured object
    (0, vitest_1.it)('P1: always returns complete structured object for any valid API response', async () => {
        await fc.assert(fc.asyncProperty(fc.record({
            sectorIndex: fc.float({ noNaN: true }),
            fearGreedIndex: fc.float({ noNaN: true }),
            fearGreedLabel: fc.string(),
        }), async (payload) => {
            mockedAxios.get = vitest_1.vi.fn().mockResolvedValue({ data: payload });
            const client = new SoSoValueClient_js_1.SoSoValueClient();
            const result = await client.fetch();
            (0, vitest_1.expect)(result).not.toBeNull();
            (0, vitest_1.expect)(typeof result.sectorIndex).toBe('number');
            (0, vitest_1.expect)(typeof result.fearGreedIndex).toBe('number');
            (0, vitest_1.expect)(typeof result.fearGreedLabel).toBe('string');
        }), { numRuns: 100 });
    });
});
