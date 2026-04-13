import * as dotenv from 'dotenv';
dotenv.config();

import { SoSoValueClient } from '../ai/SoSoValueClient.js';

async function main() {
  const client = new SoSoValueClient();
  console.log('Fetching SoSoValue data...');
  const data = await client.fetch();

  if (data) {
    console.log('✅ SoSoValue result:');
    console.log(`  Fear & Greed Index : ${data.fearGreedIndex} (${data.fearGreedLabel})`);
    console.log(`  Sector Index       : ${data.sectorIndex}`);
  } else {
    console.log('❌ Failed to fetch data');
  }
}

main().catch(err => { console.error('❌', err); process.exit(1); });
