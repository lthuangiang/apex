import * as dotenv from 'dotenv';
dotenv.config();

import { LLMClient, MarketContext } from '../ai/LLMClient.js';

// Sample market context for testing
const ctx: MarketContext = {
  sma50: 82000,
  currentPrice: 79500,
  lsRatio: 1.85,
  imbalance: 0.72,
  tradePressure: 0.38,
  fearGreedIndex: 16,
  fearGreedLabel: 'Extreme Fear',
  sectorIndex: 16,
};

async function testProvider(provider: 'openai' | 'anthropic') {
  const apiKey = provider === 'anthropic'
    ? process.env.ANTHROPIC_API_KEY ?? ''
    : process.env.OPENAI_API_KEY ?? '';

  if (!apiKey) {
    console.log(`\n⚠️  Skipping ${provider} — no API key found`);
    return;
  }

  const client = new LLMClient(provider, apiKey);

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
  } else {
    console.log('\n❌ Failed to parse decision');
  }
}

async function main() {
  const target = process.argv[2]; // optional: 'openai' or 'anthropic'

  if (target === 'openai' || target === 'anthropic') {
    await testProvider(target);
  } else {
    // Test both
    await testProvider('openai');
    await testProvider('anthropic');
  }
}

main().catch(err => { console.error('❌', err); process.exit(1); });
