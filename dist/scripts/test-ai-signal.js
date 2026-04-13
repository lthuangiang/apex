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
const dotenv = __importStar(require("dotenv"));
dotenv.config();
const sodex_adapter_js_1 = require("../adapters/sodex_adapter.js");
const decibel_adapter_js_1 = require("../adapters/decibel_adapter.js");
const AISignalEngine_js_1 = require("../ai/AISignalEngine.js");
const config_js_1 = require("../config.js");
// Build adapter based on config (same as bot.ts)
let adapter;
if (config_js_1.config.EXCHANGE === 'sodex') {
    const { SODEX_API_KEY, SODEX_API_SECRET, SODEX_SUBACCOUNT } = process.env;
    if (!SODEX_API_KEY || !SODEX_API_SECRET || !SODEX_SUBACCOUNT)
        throw new Error('Missing SoDex env vars');
    adapter = new sodex_adapter_js_1.SodexAdapter(SODEX_API_KEY, SODEX_API_SECRET, SODEX_SUBACCOUNT);
}
else {
    const { DECIBELS_PRIVATE_KEY, DECIBELS_NODE_API_KEY, DECIBELS_SUBACCOUNT } = process.env;
    if (!DECIBELS_PRIVATE_KEY || !DECIBELS_SUBACCOUNT)
        throw new Error('Missing Decibel env vars');
    adapter = new decibel_adapter_js_1.DecibelAdapter(DECIBELS_PRIVATE_KEY, DECIBELS_NODE_API_KEY ?? '0x0', DECIBELS_SUBACCOUNT);
}
async function main() {
    const symbol = config_js_1.config.SYMBOL;
    const engine = new AISignalEngine_js_1.AISignalEngine(adapter);
    console.log(`\nFetching AI signal for ${symbol}...`);
    const signal = await engine.getSignal(symbol);
    console.log('\n✅ Signal result:');
    console.log(`  Direction   : ${signal.direction}`);
    console.log(`  Confidence  : ${(signal.confidence * 100).toFixed(1)}%`);
    console.log(`  Score       : ${signal.score.toFixed(4)}`);
    console.log(`  Base Score  : ${signal.base_score.toFixed(4)}`);
    console.log(`  Regime      : ${signal.regime}`);
    console.log(`  Chart Trend : ${signal.chartTrend}`);
    console.log(`  Imbalance   : ${signal.imbalance.toFixed(4)}`);
    console.log(`  Trade Press : ${signal.tradePressure.toFixed(4)}`);
    console.log(`  Fallback    : ${signal.fallback}`);
    if (signal.reasoning) {
        console.log(`\n  Reasoning:\n  ${signal.reasoning}`);
    }
}
main().catch(err => { console.error('❌', err); process.exit(1); });
