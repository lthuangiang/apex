#!/usr/bin/env tsx
/**
 * Test different API limits to see if there are more trades available
 */
import dotenv from 'dotenv';

dotenv.config();

async function testLimit(limit: number) {
    const subaccountAddr = process.env.DECIBELS_SUBACCOUNT;
    const nodeApiKey = process.env.DECIBELS_NODE_API_KEY;
    const tradingHttpUrl = 'https://api.mainnet.aptoslabs.com/decibel';

    if (!subaccountAddr || !nodeApiKey) {
        throw new Error('Missing env vars');
    }

    const url = `${tradingHttpUrl}/api/v1/trade_history?account=${encodeURIComponent(subaccountAddr)}&limit=${limit}&offset=0`;
    const headers: Record<string, string> = {};
    if (nodeApiKey) headers['Authorization'] = `Bearer ${nodeApiKey}`;

    const res = await fetch(url, { headers });
    if (!res.ok) {
        throw new Error(`API error: ${res.status} ${res.statusText}`);
    }
    const raw = await res.json();

    let items: any[];
    let totalCount: number;

    if (Array.isArray(raw)) {
        items = raw;
        totalCount = raw.length;
    } else if (raw && Array.isArray(raw.items)) {
        items = raw.items;
        totalCount = typeof raw.total_count === 'number' ? raw.total_count : items.length;
    } else if (raw && Array.isArray(raw.data)) {
        items = raw.data;
        totalCount = typeof raw.total_count === 'number' ? raw.total_count : items.length;
    } else {
        items = [];
        totalCount = 0;
    }

    return { items, totalCount };
}

async function main() {
    console.log('🔍 Testing different API limits...\n');

    const limits = [200, 250, 500, 1000];

    for (const limit of limits) {
        console.log(`📊 Testing limit=${limit}...`);
        const { items, totalCount } = await testLimit(limit);
        
        if (items.length === 0) {
            console.log(`   ❌ No trades returned\n`);
            continue;
        }

        const timestamps = items.map(t => t.transaction_unix_ms).filter(t => t);
        const oldest = Math.min(...timestamps);
        const newest = Math.max(...timestamps);
        
        // Group by date
        const byDate: Record<string, number> = {};
        items.forEach(item => {
            if (item.transaction_unix_ms) {
                const date = new Date(item.transaction_unix_ms).toISOString().split('T')[0];
                byDate[date] = (byDate[date] || 0) + 1;
            }
        });

        console.log(`   ✅ Total count: ${totalCount}`);
        console.log(`   📦 Returned: ${items.length} trades`);
        console.log(`   ⏰ Oldest: ${new Date(oldest).toISOString()}`);
        console.log(`   ⏰ Newest: ${new Date(newest).toISOString()}`);
        console.log(`   📅 Dates covered:`);
        Object.entries(byDate)
            .sort(([a], [b]) => b.localeCompare(a))
            .forEach(([date, count]) => {
                console.log(`      ${date}: ${count} trades`);
            });
        console.log('');
    }
}

main().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});
