#!/usr/bin/env tsx
/**
 * Debug script to inspect trade timestamps from Decibel API
 */
import dotenv from 'dotenv';

dotenv.config();

async function main() {
    const subaccountAddr = process.env.DECIBELS_SUBACCOUNT;
    const nodeApiKey = process.env.DECIBELS_NODE_API_KEY;
    const tradingHttpUrl = 'https://api.mainnet.aptoslabs.com/decibel';

    if (!subaccountAddr || !nodeApiKey) {
        console.error('❌ Missing required environment variables');
        process.exit(1);
    }

    console.log('🔍 Fetching trade history to inspect timestamps...\n');

    const url = `${tradingHttpUrl}/api/v1/trade_history?account=${encodeURIComponent(subaccountAddr)}&limit=200&offset=0`;
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

    console.log(`📊 Total trades in API response: ${totalCount}`);
    console.log(`📦 Trades returned in this page: ${items.length}\n`);

    if (items.length === 0) {
        console.log('⚠️  No trades found');
        return;
    }

    // Analyze timestamps
    const timestamps = items.map(t => t.transaction_unix_ms).filter(t => t);
    const oldest = Math.min(...timestamps);
    const newest = Math.max(...timestamps);

    console.log('⏰ Timestamp Analysis:');
    console.log(`   Oldest trade: ${new Date(oldest).toISOString()}`);
    console.log(`   Newest trade: ${new Date(newest).toISOString()}`);
    console.log(`   Time span: ${((newest - oldest) / 1000 / 60 / 60).toFixed(2)} hours\n`);

    // Group by date
    const byDate: Record<string, number> = {};
    items.forEach(item => {
        if (item.transaction_unix_ms) {
            const date = new Date(item.transaction_unix_ms).toISOString().split('T')[0];
            byDate[date] = (byDate[date] || 0) + 1;
        }
    });

    console.log('📅 Trades by date:');
    Object.entries(byDate)
        .sort(([a], [b]) => b.localeCompare(a))
        .forEach(([date, count]) => {
            console.log(`   ${date}: ${count} trades`);
        });

    // Show first 5 and last 5 trades
    console.log('\n📋 First 5 trades:');
    items.slice(0, 5).forEach((t, i) => {
        const date = new Date(t.transaction_unix_ms).toISOString();
        console.log(`   ${i + 1}. ${date} - ${t.market_name || 'N/A'} - $${(t.size * t.price).toFixed(2)}`);
    });

    console.log('\n📋 Last 5 trades:');
    items.slice(-5).forEach((t, i) => {
        const date = new Date(t.transaction_unix_ms).toISOString();
        console.log(`   ${i + 1}. ${date} - ${t.market_name || 'N/A'} - $${(t.size * t.price).toFixed(2)}`);
    });
}

main().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});
