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
const os = __importStar(require("os"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const TradeLogger_js_1 = require("./TradeLogger.js");
// Feature: ai-alpha-execution-engine, Property 5: TradeLogger round-trip fidelity
// Validates: Requirements 4.1, 4.2, 4.3, 4.4
const tradeRecordArb = fc.record({
    id: fc.uuid(),
    timestamp: fc.date({ min: new Date('2020-01-01'), max: new Date('2030-01-01') }).map((d) => d.toISOString()),
    symbol: fc.constantFrom('BTC-USD', 'ETH-USD', 'SOL-USD'),
    direction: fc.constantFrom('long', 'short'),
    confidence: fc.float({ min: 0, max: 1, noNaN: true }),
    reasoning: fc.string({ minLength: 0, maxLength: 500 }),
    fallback: fc.boolean(),
    entryPrice: fc.float({ min: Math.fround(0.01), max: Math.fround(1_000_000), noNaN: true }),
    exitPrice: fc.float({ min: Math.fround(0.01), max: Math.fround(1_000_000), noNaN: true }),
    pnl: fc.float({ min: Math.fround(-100_000), max: Math.fround(100_000), noNaN: true }),
    sessionPnl: fc.float({ min: Math.fround(-100_000), max: Math.fround(100_000), noNaN: true }),
});
function makeTempPath(ext) {
    return path.join(os.tmpdir(), `trade-logger-test-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
}
(0, vitest_1.describe)('TradeLogger — Property 5: round-trip fidelity (JSON backend)', () => {
    const tempFiles = [];
    (0, vitest_1.afterEach)(() => {
        for (const f of tempFiles) {
            try {
                fs.unlinkSync(f);
            }
            catch { /* ignore */ }
        }
        tempFiles.length = 0;
    });
    (0, vitest_1.it)('logged record is returned by readAll() with identical fields', async () => {
        await fc.assert(fc.asyncProperty(tradeRecordArb, async (record) => {
            const logPath = makeTempPath('json');
            tempFiles.push(logPath);
            const logger = new TradeLogger_js_1.TradeLogger('json', logPath);
            logger.log(record);
            // Give the fire-and-forget async write time to complete
            await new Promise((resolve) => setTimeout(resolve, 50));
            const all = await logger.readAll();
            const found = all.find((r) => r.id === record.id);
            (0, vitest_1.expect)(found).toBeDefined();
            (0, vitest_1.expect)(found.id).toBe(record.id);
            (0, vitest_1.expect)(found.timestamp).toBe(record.timestamp);
            (0, vitest_1.expect)(found.symbol).toBe(record.symbol);
            (0, vitest_1.expect)(found.direction).toBe(record.direction);
            (0, vitest_1.expect)(found.confidence).toBeCloseTo(record.confidence, 10);
            (0, vitest_1.expect)(found.reasoning).toBe(record.reasoning);
            (0, vitest_1.expect)(found.fallback).toBe(record.fallback);
            (0, vitest_1.expect)(found.entryPrice).toBeCloseTo(record.entryPrice, 5);
            (0, vitest_1.expect)(found.exitPrice).toBeCloseTo(record.exitPrice, 5);
            (0, vitest_1.expect)(found.pnl).toBeCloseTo(record.pnl, 5);
            (0, vitest_1.expect)(found.sessionPnl).toBeCloseTo(record.sessionPnl, 5);
        }), { numRuns: 50 });
    });
});
(0, vitest_1.describe)('TradeLogger — Property 5: round-trip fidelity (SQLite backend)', () => {
    const tempFiles = [];
    (0, vitest_1.afterEach)(() => {
        for (const f of tempFiles) {
            try {
                fs.unlinkSync(f);
            }
            catch { /* ignore */ }
        }
        tempFiles.length = 0;
    });
    (0, vitest_1.it)('logged record is returned by readAll() with identical fields', async () => {
        await fc.assert(fc.asyncProperty(tradeRecordArb, async (record) => {
            const logPath = makeTempPath('db');
            tempFiles.push(logPath);
            const logger = new TradeLogger_js_1.TradeLogger('sqlite', logPath);
            logger.log(record);
            // SQLite is synchronous — no delay needed, but readAll is async
            const all = await logger.readAll();
            const found = all.find((r) => r.id === record.id);
            (0, vitest_1.expect)(found).toBeDefined();
            (0, vitest_1.expect)(found.id).toBe(record.id);
            (0, vitest_1.expect)(found.timestamp).toBe(record.timestamp);
            (0, vitest_1.expect)(found.symbol).toBe(record.symbol);
            (0, vitest_1.expect)(found.direction).toBe(record.direction);
            (0, vitest_1.expect)(found.confidence).toBeCloseTo(record.confidence, 10);
            (0, vitest_1.expect)(found.reasoning).toBe(record.reasoning);
            (0, vitest_1.expect)(found.fallback).toBe(record.fallback);
            (0, vitest_1.expect)(found.entryPrice).toBeCloseTo(record.entryPrice, 5);
            (0, vitest_1.expect)(found.exitPrice).toBeCloseTo(record.exitPrice, 5);
            (0, vitest_1.expect)(found.pnl).toBeCloseTo(record.pnl, 5);
            (0, vitest_1.expect)(found.sessionPnl).toBeCloseTo(record.sessionPnl, 5);
        }), { numRuns: 50 });
    });
});
