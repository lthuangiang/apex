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
const vitest_1 = require("vitest");
const fc = __importStar(require("fast-check"));
const os = __importStar(require("os"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const supertest_1 = __importDefault(require("supertest"));
const TradeLogger_js_1 = require("../ai/TradeLogger.js");
const sharedState_js_1 = require("../ai/sharedState.js");
const server_js_1 = require("./server.js");
// Feature: ai-alpha-execution-engine, Property 8: Dashboard trades endpoint returns records ordered by timestamp descending
// Validates: Requirements 6.2
// Feature: ai-alpha-execution-engine, Property 9: Dashboard PnL endpoint reflects current shared state
// Validates: Requirements 7.2
const tradeRecordArb = (timestamp) => fc.record({
    id: fc.uuid(),
    timestamp: fc.constant(timestamp),
    symbol: fc.constantFrom('BTC-USD', 'ETH-USD', 'SOL-USD'),
    direction: fc.constantFrom('long', 'short'),
    confidence: fc.float({ min: 0, max: 1, noNaN: true }),
    reasoning: fc.string({ minLength: 0, maxLength: 200 }),
    fallback: fc.boolean(),
    entryPrice: fc.float({ min: Math.fround(0.01), max: Math.fround(1_000_000), noNaN: true }),
    exitPrice: fc.float({ min: Math.fround(0.01), max: Math.fround(1_000_000), noNaN: true }),
    pnl: fc.float({ min: Math.fround(-100_000), max: Math.fround(100_000), noNaN: true }),
    sessionPnl: fc.float({ min: Math.fround(-100_000), max: Math.fround(100_000), noNaN: true }),
});
function makeTempPath(ext) {
    return path.join(os.tmpdir(), `dashboard-test-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
}
(0, vitest_1.describe)('DashboardServer — Property 8: trades endpoint returns records ordered by timestamp descending', () => {
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
    (0, vitest_1.it)('GET /api/trades returns records sorted by timestamp descending', async () => {
        await fc.assert(fc.asyncProperty(fc.array(fc.date({ min: new Date('2020-01-01'), max: new Date('2030-01-01') }).map((d) => d.toISOString()), { minLength: 2, maxLength: 10 }), async (timestamps) => {
            const logPath = makeTempPath('json');
            tempFiles.push(logPath);
            const logger = new TradeLogger_js_1.TradeLogger('json', logPath);
            const server = new server_js_1.DashboardServer(logger, 0);
            // Build and log one record per timestamp
            for (const ts of timestamps) {
                const [record] = fc.sample(tradeRecordArb(ts), 1);
                logger.log(record);
            }
            // Wait for fire-and-forget writes to complete
            await new Promise((resolve) => setTimeout(resolve, 30));
            const res = await (0, supertest_1.default)(server.app).get('/api/trades');
            (0, vitest_1.expect)(res.status).toBe(200);
            const body = res.body;
            (0, vitest_1.expect)(Array.isArray(body)).toBe(true);
            // Assert descending order
            for (let i = 0; i < body.length - 1; i++) {
                (0, vitest_1.expect)(body[i].timestamp >= body[i + 1].timestamp).toBe(true);
            }
        }), { numRuns: 30 });
    }, 30_000);
});
(0, vitest_1.describe)('DashboardServer — Property 9: PnL endpoint reflects current shared state', () => {
    (0, vitest_1.it)('GET /api/pnl returns the current sharedState.sessionPnl value', async () => {
        const logPath = makeTempPath('json');
        const logger = new TradeLogger_js_1.TradeLogger('json', logPath);
        const server = new server_js_1.DashboardServer(logger, 0);
        await fc.assert(fc.asyncProperty(fc.float({ noNaN: true }), async (pnl) => {
            sharedState_js_1.sharedState.sessionPnl = pnl;
            sharedState_js_1.sharedState.updatedAt = new Date().toISOString();
            const res = await (0, supertest_1.default)(server.app).get('/api/pnl');
            (0, vitest_1.expect)(res.status).toBe(200);
            // JSON serialization normalizes -0 to 0, so use == comparison
            (0, vitest_1.expect)(res.body.sessionPnl == pnl).toBe(true);
        }), { numRuns: 100 });
        // Cleanup
        try {
            fs.unlinkSync(logPath);
        }
        catch { /* ignore */ }
    });
});
