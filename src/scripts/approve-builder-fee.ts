/**
 * One-time setup script: approve builder fee on Decibel DEX.
 * Run this ONCE after funding your Aptos account with APT for gas.
 *
 * Usage: npx tsx src/scripts/approve-builder-fee.ts
 */
import 'dotenv/config';
import { DecibelAdapter } from '../adapters/decibel_adapter.js';

async function main() {
    const { DECIBELS_PRIVATE_KEY, DECIBELS_NODE_API_KEY, DECIBELS_SUBACCOUNT } = process.env;

    if (!DECIBELS_PRIVATE_KEY || !DECIBELS_SUBACCOUNT) {
        console.error('Missing DECIBELS_PRIVATE_KEY or DECIBELS_SUBACCOUNT in .env');
        process.exit(1);
    }

    const adapter = new DecibelAdapter(
        DECIBELS_PRIVATE_KEY,
        DECIBELS_NODE_API_KEY ?? '0x0',
        DECIBELS_SUBACCOUNT,
        process.env.DECIBELS_BUILDER_ADDRESS ?? '0x5eefc26ee8f0b537717e57718a9a0c365e32081d96dc618a56041b3b7ff31ed5'
    );

    console.log('Approving builder fee (10 bps = 0.1%)...');
    console.log('Builder address:', process.env.DECIBELS_BUILDER_ADDRESS ?? '0x5eefc26ee8f0b537717e57718a9a0c365e32081d96dc618a56041b3b7ff31ed5');
    console.log('NOTE: This requires APT in your wallet for gas fees.');

    try {
        await adapter.approveBuilderFee(10);
        console.log('✅ Builder fee approved successfully.');
    } catch (e: any) {
        console.error('❌ Failed:', e?.message ?? e);
        console.error('Make sure your Aptos account has APT for gas fees.');
        process.exit(1);
    }
}

main();
