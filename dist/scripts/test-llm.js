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
const LLMClient_js_1 = require("../ai/LLMClient.js");
// Sample market context for testing
const ctx = {
    sma50: 82000,
    currentPrice: 79500,
    lsRatio: 1.85,
    imbalance: 0.72,
    tradePressure: 0.38,
    fearGreedIndex: 16,
    fearGreedLabel: 'Extreme Fear',
    sectorIndex: 16,
};
async function testProvider(provider) {
    const apiKey = provider === 'anthropic'
        ? process.env.ANTHROPIC_API_KEY ?? ''
        : process.env.OPENAI_API_KEY ?? '';
    if (!apiKey) {
        console.log(`\n⚠️  Skipping ${provider} — no API key found`);
        return;
    }
    const client = new LLMClient_js_1.LLMClient(provider, apiKey);
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Provider : ${provider.toUpperCase()}`);
    console.log(`${'─'.repeat(60)}`);
    console.log('\n📤 REQUEST PROMPT:');
    console.log(client.buildPrompt(ctx));
    console.log('\n⏳ Calling LLM...');
    const start = Date.now();
    const result = await client.callWithRaw(ctx);
    const elapsed = Date.now() - start;
    console.log(`\n📥 RAW RESPONSE (${elapsed}ms):`);
    console.log(result.raw ?? '(empty)');
    if (result.decision) {
        console.log('\n✅ PARSED DECISION:');
        console.log(`  Direction  : ${result.decision.direction}`);
        console.log(`  Confidence : ${(result.decision.confidence * 100).toFixed(1)}%`);
        console.log(`  Reasoning  : ${result.decision.reasoning}`);
    }
    else {
        console.log('\n❌ Failed to parse decision');
    }
}
async function main() {
    const target = process.argv[2]; // optional: 'openai' or 'anthropic'
    if (target === 'openai' || target === 'anthropic') {
        await testProvider(target);
    }
    else {
        // Test both
        await testProvider('openai');
        await testProvider('anthropic');
    }
}
main().catch(err => { console.error('❌', err); process.exit(1); });
