/**
 * Test script: fetch raw account balance and account ID from SoDex API
 * Usage: npm run test:balance
 */
import 'dotenv/config';
import { SodexAdapter } from '../adapters/sodex_adapter.js';

async function main() {
    const { SODEX_API_KEY, SODEX_API_SECRET, SODEX_SUBACCOUNT } = process.env;

    if (!SODEX_API_KEY || !SODEX_API_SECRET || !SODEX_SUBACCOUNT) {
        console.error('Missing SODEX_API_KEY, SODEX_API_SECRET or SODEX_SUBACCOUNT in .env');
        process.exit(1);
    }

    const adapter = new SodexAdapter(SODEX_API_KEY, SODEX_API_SECRET, SODEX_SUBACCOUNT);

    console.log('\n── Account ID ──────────────────────────────');
    const accountId = await adapter.getAccountId();
    console.log('Parsed accountId:', accountId);

    console.log('\n── Balance ─────────────────────────────────');
    const balance = await adapter.get_balance();
    console.log('Parsed balance:', balance);
}

main().catch(e => { console.error(e); process.exit(1); });
