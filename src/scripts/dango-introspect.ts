/**
 * Dango GraphQL Schema Introspection
 * Dumps all available query fields and their args to understand the real API.
 *
 * Run: npm run dango:introspect
 */

import axios from 'axios';
import * as dotenv from 'dotenv';
dotenv.config();

const ENDPOINT = 'https://api-mainnet.dango.zone/graphql';
const PERPS_CONTRACT = '0x90bc84df68d1aa59a857e04ed529e9a26edbea4f';

async function gql<T = any>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const res = await axios.post(ENDPOINT, { query, variables }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000,
    });
    if (res.data.errors) throw new Error(JSON.stringify(res.data.errors, null, 2));
    return res.data.data as T;
}

async function introspectQueryFields() {
    console.log('\n📋 QUERY ROOT FIELDS:');
    const data = await gql<any>(`
        query {
            __type(name: "Query") {
                fields {
                    name
                    description
                    args { name type { name kind ofType { name kind } } }
                }
            }
        }
    `);
    const fields = data.__type?.fields ?? [];
    for (const f of fields) {
        const args = f.args?.map((a: any) => `${a.name}: ${a.type?.name ?? a.type?.ofType?.name ?? '?'}`).join(', ') ?? '';
        console.log(`  ${f.name}(${args})`);
        if (f.description) console.log(`    → ${f.description}`);
    }
}

async function introspectPerpsFields() {
    console.log('\n📋 PERPS-RELATED QUERY FIELDS:');
    const data = await gql<any>(`
        query {
            __type(name: "Query") {
                fields {
                    name
                    args { name type { name kind ofType { name kind } } }
                }
            }
        }
    `);
    const fields = (data.__type?.fields ?? []).filter((f: any) =>
        f.name.toLowerCase().includes('perp') ||
        f.name.toLowerCase().includes('order') ||
        f.name.toLowerCase().includes('position') ||
        f.name.toLowerCase().includes('balance') ||
        f.name.toLowerCase().includes('account') ||
        f.name.toLowerCase().includes('user') ||
        f.name.toLowerCase().includes('trade') ||
        f.name.toLowerCase().includes('candle')
    );
    for (const f of fields) {
        const args = f.args?.map((a: any) => `${a.name}: ${a.type?.name ?? a.type?.ofType?.name ?? '?'}`).join(', ') ?? '';
        console.log(`  ${f.name}(${args})`);
    }
}

async function testQueryApp(msg: Record<string, unknown>, label: string) {
    console.log(`\n🔍 queryApp: ${label}`);
    console.log(`   msg: ${JSON.stringify(msg)}`);
    try {
        const data = await gql<any>(`
            query QueryApp($msg: JSON!) {
                queryApp(request: { wasm_smart: { contract: "${PERPS_CONTRACT}", msg: $msg } })
            }
        `, { msg });
        console.log(`   ✅ result:`, JSON.stringify(data.queryApp).slice(0, 300));
    } catch (e: any) {
        console.log(`   ❌ error:`, e.message.slice(0, 200));
    }
}

async function testAccountsQuery(address: string) {
    console.log(`\n🔍 accounts query for: ${address}`);
    // Try different query formats
    const queries = [
        `query { accounts(after: "", first: 1, address: "${address}") { nodes { address users { userIndex } } } }`,
        `query { users(first: 3, publicKey: "${address}") { nodes { userIndex publicKey { secp256k1 } } } }`,
        `query { users(first: 5) { nodes { userIndex publicKey { secp256k1 } } } }`,
    ];
    for (const q of queries) {
        try {
            const data = await gql<any>(q);
            console.log(`   ✅ query worked:`, JSON.stringify(data).slice(0, 500));
        } catch (e: any) {
            console.log(`   ❌ failed:`, e.message.slice(0, 150));
        }
    }
}

async function testPerpsCandleFields() {
    console.log('\n🔍 PerpsCandle type fields:');
    const data = await gql<any>(`
        query {
            __type(name: "PerpsCandle") {
                fields { name type { name kind ofType { name } } }
            }
        }
    `);
    const fields = data.__type?.fields ?? [];
    for (const f of fields) {
        console.log(`  ${f.name}: ${f.type?.name ?? f.type?.ofType?.name ?? f.type?.kind}`);
    }
}

async function testSigningKeyFormats() {
    console.log('\n🔍 Testing private key formats for ethers.SigningKey:');
    const rawKey = process.env.DANGO_PRIVATE_KEY ?? '';
    const { ethers } = await import('ethers');
    const formats = [
        rawKey,
        rawKey.startsWith('0x') ? rawKey : '0x' + rawKey,
        rawKey.startsWith('0x') ? rawKey.slice(2) : rawKey,
    ];
    for (const k of formats) {
        try {
            const sk = new ethers.SigningKey(k.startsWith('0x') ? k : '0x' + k);
            console.log(`  ✅ format "${k.slice(0, 8)}..." works → pubkey: ${sk.compressedPublicKey.slice(0, 20)}...`);
        } catch (e: any) {
            console.log(`  ❌ format "${k.slice(0, 8)}..." failed: ${e.message.slice(0, 80)}`);
        }
    }
}

async function testUserStateWithBech32() {
    // Try to find the bech32 address from the accounts query
    const address = process.env.DANGO_USER_ADDRESS ?? '';
    console.log(`\n🔍 Looking up bech32 address for: ${address}`);
    
    // Try accounts query with the address
    try {
        const data = await gql<any>(`
            query {
                accounts(address: "${address}", first: 1) {
                    nodes { address username users { userIndex } }
                }
            }
        `);
        console.log('  accounts result:', JSON.stringify(data).slice(0, 400));
    } catch (e: any) {
        console.log('  ❌', e.message.slice(0, 200));
    }

    // Try to get all accounts to see address format
    try {
        const data = await gql<any>(`
            query {
                accounts(first: 3) {
                    nodes { address username users { userIndex } }
                }
            }
        `);
        console.log('  sample accounts:', JSON.stringify(data).slice(0, 400));
    } catch (e: any) {
        console.log('  ❌', e.message.slice(0, 200));
    }
}

async function testPerpsPairStats() {
    console.log('\n🔍 perpsPairStats query:');
    try {
        const data = await gql<any>(`
            query {
                perpsPairStats(pairId: "perp/btcusd") {
                    currentPrice
                    openInterest
                    fundingRate
                }
            }
        `);
        console.log('   ✅', JSON.stringify(data).slice(0, 300));
    } catch (e: any) {
        console.log('   ❌', e.message.slice(0, 200));
    }
}

async function testPerpsCandles() {
    console.log('\n🔍 perpsCandles query (instead of perpsTrades):');
    try {
        const data = await gql<any>(`
            query {
                perpsCandles(pairId: "perp/btcusd", resolution: "1m", first: 3) {
                    nodes { openTime closeTime openPrice closePrice highPrice lowPrice volume }
                }
            }
        `);
        console.log('   ✅', JSON.stringify(data).slice(0, 300));
    } catch (e: any) {
        console.log('   ❌', e.message.slice(0, 200));
    }
}

async function testLiquidityDepth() {
    console.log('\n🔍 liquidity_depth contract query:');
    // Try different bucket sizes and limits
    const variants = [
        { liquidity_depth: { pair_id: 'perp/btcusd', bucket_size: '10.000000', limit: 5 } },
        { liquidity_depth: { pair_id: 'perp/btcusd', bucket_size: '100', limit: 5 } },
        { liquidity_depth: { pair_id: 'perp/btcusd', limit: 5 } },
        { order_book: { pair_id: 'perp/btcusd', limit: 5 } },
    ];
    for (const msg of variants) {
        await testQueryApp(msg, JSON.stringify(msg).slice(0, 80));
    }
}

async function testUserStateVariants(address: string) {
    console.log(`\n🔍 user_state variants for: ${address}`);
    const variants = [
        { user_state: { user: address } },
        { user_state: { addr: address } },
        { user_state: { address } },
        { balance: { user: address } },
        { margin: { user: address } },
    ];
    for (const msg of variants) {
        await testQueryApp(msg, JSON.stringify(msg).slice(0, 80));
    }
}

async function testOrdersVariants(address: string) {
    console.log(`\n🔍 orders query variants for: ${address}`);
    const variants = [
        { orders_by_user: { user: address } },
        { orders: { user: address } },
        { open_orders: { user: address } },
        { orders_by_user: { addr: address } },
    ];
    for (const msg of variants) {
        await testQueryApp(msg, JSON.stringify(msg).slice(0, 80));
    }
}

async function main() {
    const address = process.env.DANGO_USER_ADDRESS ?? '';
    if (!address) {
        console.error('DANGO_USER_ADDRESS not set in .env');
        process.exit(1);
    }

    console.log('🦷 DANGO SCHEMA INTROSPECTION');
    console.log(`   Endpoint: ${ENDPOINT}`);
    console.log(`   Address:  ${address}`);

    await introspectQueryFields();
    await introspectPerpsFields();
    await testPerpsPairStats();
    await testPerpsCandles();
    await testLiquidityDepth();
    await testUserStateVariants(address);
    await testOrdersVariants(address);
    await testAccountsQuery(address);
    await testPerpsCandleFields();
    await testSigningKeyFormats();
    await testUserStateWithBech32();

    // Test getUserIndex with new accounts(address:) approach
    console.log(`\n🔍 getUserIndex via accounts(address: "${address}"):`)
    try {
        const data = await gql<any>(`
            query {
                accounts(address: "${address}", first: 1) {
                    nodes { address users { userIndex } }
                }
            }
        `);
        console.log('  result:', JSON.stringify(data).slice(0, 300));
    } catch (e: any) {
        console.log('  ❌', e.message.slice(0, 200));
    }
}

main().catch(err => {
    console.error('💥', err.message ?? err);
    process.exit(1);
});
