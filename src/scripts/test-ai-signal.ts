import * as dotenv from 'dotenv';
dotenv.config();

import { SodexAdapter } from '../adapters/sodex_adapter.js';
import { DecibelAdapter } from '../adapters/decibel_adapter.js';
import { AISignalEngine } from '../ai/AISignalEngine.js';
import { config } from '../config.js';

// Build adapter based on config (same as bot.ts)
let adapter;
if (config.EXCHANGE === 'sodex') {
  const { SODEX_API_KEY, SODEX_API_SECRET, SODEX_SUBACCOUNT } = process.env;
  if (!SODEX_API_KEY || !SODEX_API_SECRET || !SODEX_SUBACCOUNT) throw new Error('Missing SoDex env vars');
  adapter = new SodexAdapter(SODEX_API_KEY, SODEX_API_SECRET, SODEX_SUBACCOUNT);
} else {
  const { DECIBELS_PRIVATE_KEY, DECIBELS_NODE_API_KEY, DECIBELS_SUBACCOUNT } = process.env;
  if (!DECIBELS_PRIVATE_KEY || !DECIBELS_SUBACCOUNT) throw new Error('Missing Decibel env vars');
  adapter = new DecibelAdapter(
    DECIBELS_PRIVATE_KEY,
    DECIBELS_NODE_API_KEY ?? '0x0',
    DECIBELS_SUBACCOUNT,
    process.env.DECIBELS_BUILDER_ADDRESS ?? '0x5eefc26ee8f0b537717e57718a9a0c365e32081d96dc618a56041b3b7ff31ed5'
  );
}

async function main() {
  const symbol = config.SYMBOL;
  const engine = new AISignalEngine(adapter);

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
