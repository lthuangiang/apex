#!/usr/bin/env tsx
/**
 * Fetch and display trade volume for the last four days from Decibel
 */
import dotenv from 'dotenv';

dotenv.config();

interface TradeItem {
    transaction_unix_ms: number;
    size: number;
    price: number;
}

interface VolumeResult {
    date: string;
    volume: number;
    tradeCount: number;
}

async function fetchPage(
    tradingHttpUrl: string,
    subaccountAddr: string,
    nodeApiKey: string,
    limit: number,
    offset: number
): Promise<{ items: TradeItem[]; totalCount: number }> {
    const url = `${tradingHttpUrl}/api/v1/trade_history?account=${encodeURIComponent(subaccountAddr)}&limit=${limit}&offset=${offset}`;
    const headers: Record<string, string> = {};
    if (nodeApiKey) headers['Authorization'] = `Bearer ${nodeApiKey}`;

    const res = await fetch(url, { headers });
    if (!res.ok) {
        throw new Error(`trade_history API error: ${res.status} ${res.statusText}`);
    }
    const raw = await res.json();

    // Handle all known response formats
    let items: TradeItem[];
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

async function getVolumeForDay(
    tradingHttpUrl: string,
    subaccountAddr: string,
    nodeApiKey: string,
    startMs: number,
    endMs: number
): Promise<{ volume: number; tradeCount: number }> {
    let totalVolume = 0;
    let tradeCount = 0;
    let offset = 0;
    const limit = 200;

    // Fetch first page
    const firstPage = await fetchPage(tradingHttpUrl, subaccountAddr, nodeApiKey, limit, offset);
    
    for (const item of firstPage.items) {
        if (item.transaction_unix_ms >= startMs && item.transaction_unix_ms < endMs) {
            totalVolume += (item.size ?? 0) * (item.price ?? 0);
            tradeCount++;
        }
    }

    // Paginate if needed
    offset += limit;
    while (offset < firstPage.totalCount) {
        const page = await fetchPage(tradingHttpUrl, subaccountAddr, nodeApiKey, limit, offset);
        for (const item of page.items) {
            if (item.transaction_unix_ms >= startMs && item.transaction_unix_ms < endMs) {
                totalVolume += (item.size ?? 0) * (item.price ?? 0);
                tradeCount++;
            }
        }
        offset += limit;
    }

    return { volume: totalVolume, tradeCount };
}

async function main() {
    const subaccountAddr = process.env.DECIBELS_SUBACCOUNT;
    const nodeApiKey = process.env.DECIBELS_NODE_API_KEY;
    const tradingHttpUrl = 'https://api.mainnet.aptoslabs.com/decibel';

    if (!subaccountAddr || !nodeApiKey) {
        console.error('❌ Missing required environment variables:');
        console.error('   DECIBELS_SUBACCOUNT');
        console.error('   DECIBELS_NODE_API_KEY');
        process.exit(1);
    }

    console.log('🔍 Fetching trade volume for the last 4 days...\n');
    console.log(`📍 Subaccount: ${subaccountAddr}\n`);

    const now = new Date();
    const volumes: VolumeResult[] = [];

    for (let daysAgo = 0; daysAgo < 4; daysAgo++) {
        const targetDate = new Date(now);
        targetDate.setUTCDate(now.getUTCDate() - daysAgo);
        
        const dayStartMs = Date.UTC(
            targetDate.getUTCFullYear(),
            targetDate.getUTCMonth(),
            targetDate.getUTCDate()
        );
        const dayEndMs = dayStartMs + 86_400_000; // 24 hours in ms

        console.log(`⏳ Fetching data for ${targetDate.toISOString().split('T')[0]}...`);
        
        const { volume, tradeCount } = await getVolumeForDay(
            tradingHttpUrl,
            subaccountAddr,
            nodeApiKey,
            dayStartMs,
            dayEndMs
        );
        
        const dateStr = targetDate.toISOString().split('T')[0];
        volumes.push({ date: dateStr, volume, tradeCount });
        
        console.log(`   ✅ Volume: $${volume.toFixed(2)} (${tradeCount} trades)\n`);
    }

    // Display summary
    console.log('═══════════════════════════════════════════');
    console.log('        FOUR-DAY VOLUME SUMMARY');
    console.log('═══════════════════════════════════════════\n');
    
    volumes.forEach(({ date, volume, tradeCount }) => {
        console.log(`📅 ${date}`);
        console.log(`   💰 Volume: $${volume.toFixed(2)}`);
        console.log(`   📊 Trades: ${tradeCount}`);
        console.log('');
    });

    const totalVolume = volumes.reduce((sum, v) => sum + v.volume, 0);
    const totalTrades = volumes.reduce((sum, v) => sum + v.tradeCount, 0);
    const avgVolume = totalVolume / volumes.length;
    const avgTrades = totalTrades / volumes.length;
    
    console.log('═══════════════════════════════════════════');
    console.log(`📈 Total 4-day volume:    $${totalVolume.toFixed(2)}`);
    console.log(`📊 Total trades:          ${totalTrades}`);
    console.log(`📉 Average daily volume:  $${avgVolume.toFixed(2)}`);
    console.log(`📊 Average daily trades:  ${avgTrades.toFixed(0)}`);
    console.log('═══════════════════════════════════════════');
}

main().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});
