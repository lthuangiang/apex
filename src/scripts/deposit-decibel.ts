/**
 * Deposit USDC from API wallet into Decibel trading account (subaccount).
 *
 * Prerequisites:
 *   1. API wallet (DECIBELS_PRIVATE_KEY) must hold USDC on Aptos mainnet
 *      → Transfer USDC from your Primary account to API wallet first using Petra/Pontem
 *   2. Gas station key set (DECIBELS_GAS_STATION_API_KEY) OR API wallet has APT for gas
 *
 * Usage:
 *   npx tsx src/scripts/deposit-decibel.ts <amount_usdc>
 *   npx tsx src/scripts/deposit-decibel.ts 100
 *
 * To withdraw:
 *   npx tsx src/scripts/deposit-decibel.ts withdraw <amount_usdc>
 *   npx tsx src/scripts/deposit-decibel.ts withdraw 50
 */
import 'dotenv/config';
// @ts-ignore
import * as decibelSdk from '@decibeltrade/sdk';
const { DecibelWriteDex, MAINNET_CONFIG, GasPriceManager } = decibelSdk as any;
import { Ed25519Account, Ed25519PrivateKey } from '@aptos-labs/ts-sdk';

const USDC_DECIMALS = 6; // USDC has 6 decimals on Aptos

function toChainAmount(usd: number): number {
    return Math.floor(usd * Math.pow(10, USDC_DECIMALS));
}

async function main() {
    const { DECIBELS_PRIVATE_KEY, DECIBELS_NODE_API_KEY, DECIBELS_GAS_STATION_API_KEY } = process.env;

    if (!DECIBELS_PRIVATE_KEY) {
        console.error('❌ Missing DECIBELS_PRIVATE_KEY in .env');
        process.exit(1);
    }

    const isWithdraw = process.argv[2] === 'withdraw';
    const amountArg = isWithdraw ? process.argv[3] : process.argv[2];
    const amountUsd = parseFloat(amountArg ?? '0');

    if (!amountUsd || isNaN(amountUsd) || amountUsd <= 0) {
        console.error('❌ Usage: npx tsx src/scripts/deposit-decibel.ts [withdraw] <amount_usdc>');
        console.error('   Example: npx tsx src/scripts/deposit-decibel.ts 100');
        console.error('   Example: npx tsx src/scripts/deposit-decibel.ts withdraw 50');
        process.exit(1);
    }

    const cleanKey = (val: string) => {
        let res = val.trim();
        while (res.startsWith('ed25519-priv-') || res.startsWith('0x')) {
            res = res.replace(/^ed25519-priv-/, '').replace(/^0x/, '');
        }
        return res;
    };

    const account = new Ed25519Account({
        privateKey: new Ed25519PrivateKey(cleanKey(DECIBELS_PRIVATE_KEY)),
    });

    const apiWallet = account.accountAddress.toString();
    console.log(`\n🔑 API Wallet : ${apiWallet}`);
    console.log(`💰 Amount     : ${amountUsd} USDC`);
    console.log(`📋 Action     : ${isWithdraw ? 'WITHDRAW from trading account' : 'DEPOSIT to trading account'}`);

    const effectiveGasKey = DECIBELS_GAS_STATION_API_KEY?.trim();
    const writeConfig = effectiveGasKey
        ? { ...MAINNET_CONFIG, gasStationApiKey: effectiveGasKey }
        : MAINNET_CONFIG;

    if (effectiveGasKey) {
        console.log('⛽ Gas        : Gas Station (sponsored)');
    } else {
        console.log('⛽ Gas        : Self-pay (API wallet needs APT)');
    }

    const nodeApiKey = cleanKey(DECIBELS_NODE_API_KEY ?? '');
    const writeOpts: any = { nodeApiKey, skipSimulate: false };

    let write = new DecibelWriteDex(writeConfig, account, writeOpts);

    // Try to init GasPriceManager for faster tx
    if (typeof GasPriceManager === 'function') {
        try {
            const gas = new GasPriceManager(writeConfig);
            await gas.initialize();
            write = new DecibelWriteDex(writeConfig, account, { ...writeOpts, gasPriceManager: gas });
            console.log('✅ GasPriceManager initialized');
        } catch (e: any) {
            console.warn('⚠️  GasPriceManager init failed, using default gas');
        }
    }

    const chainAmount = toChainAmount(amountUsd);
    console.log(`\n🔄 Sending transaction...`);

    try {
        let result: any;
        if (isWithdraw) {
            result = await write.withdraw(chainAmount);
        } else {
            result = await write.deposit(chainAmount);
        }

        console.log(`\n✅ ${isWithdraw ? 'Withdrawal' : 'Deposit'} successful!`);
        console.log(`   TX hash : ${result?.hash ?? JSON.stringify(result)}`);
        console.log(`\n💡 Trading account is now active. Update DECIBELS_SUBACCOUNT in .env if needed.`);
    } catch (err: any) {
        const msg = err?.response?.data ?? err?.message ?? err;
        console.error(`\n❌ Transaction failed:`, JSON.stringify(msg, null, 2));

        if (JSON.stringify(msg).includes('INSUFFICIENT_BALANCE')) {
            console.error('\n💡 API wallet does not have enough USDC.');
            console.error('   Transfer USDC from your Primary account to API wallet first:');
            console.error(`   → Send USDC to: ${apiWallet}`);
        }
        process.exit(1);
    }
}

main().catch(e => {
    console.error('\n💥 Fatal:', e?.message ?? e);
    process.exit(1);
});
