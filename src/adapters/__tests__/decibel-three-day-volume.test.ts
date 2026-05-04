import { describe, it, expect } from 'vitest';
import dotenv from 'dotenv';

dotenv.config();

interface TradeItem {
    transaction_unix_ms: number;
    size: number;
    price: number;
}

describe('Decibel Four-Day Volume Test', () => {
    it('should fetch trade volume for the last four days', async () => {
        const subaccountAddr = process.env.DECIBELS_SUBACCOUNT;
        const nodeApiKey = process.env.DECIBELS_NODE_API_KEY;
        const tradingHttpUrl = 'https://api.mainnet.aptoslabs.com/decibel';

        if (!subaccountAddr || !nodeApiKey) {
            console.warn('⚠️  Skipping test: Missing DECIBELS_SUBACCOUNT or DECIBELS_NODE_API_KEY');
            return;
        }

        // Calculate timestamps for the last 4 days
        const now = new Date();
        const volumes: { date: string; volume: number; tradeCount: number }[] = [];

        for (let daysAgo = 0; daysAgo < 4; daysAgo++) {
            const targetDate = new Date(now);
            targetDate.setUTCDate(now.getUTCDate() - daysAgo);
            
            const dayStartMs = Date.UTC(
                targetDate.getUTCFullYear(),
                targetDate.getUTCMonth(),
                targetDate.getUTCDate()
            );
            const dayEndMs = dayStartMs + 86_400_000; // 24 hours in ms

            // Fetch trade history for this day
            const { volume, tradeCount } = await getVolumeForDay(
                tradingHttpUrl,
                subaccountAddr,
                nodeApiKey,
                dayStartMs,
                dayEndMs
            );
            
            const dateStr = targetDate.toISOString().split('T')[0];
            volumes.push({ date: dateStr, volume, tradeCount });
            
            console.log(`📊 ${dateStr}: $${volume.toFixed(2)} (${tradeCount} trades)`);
        }

        // Display summary
        console.log('\n=== Four-Day Volume Summary ===');
        volumes.forEach(({ date, volume, tradeCount }) => {
            console.log(`${date}: $${volume.toFixed(2)} (${tradeCount} trades)`);
        });

        const totalVolume = volumes.reduce((sum, v) => sum + v.volume, 0);
        const totalTrades = volumes.reduce((sum, v) => sum + v.tradeCount, 0);
        const avgVolume = totalVolume / volumes.length;
        
        console.log(`\nTotal 4-day volume: $${totalVolume.toFixed(2)}`);
        console.log(`Total trades: ${totalTrades}`);
        console.log(`Average daily volume: $${avgVolume.toFixed(2)}`);

        // Assertions
        expect(volumes).toHaveLength(4);
        volumes.forEach(({ volume }) => {
            expect(volume).toBeGreaterThanOrEqual(0);
        });
    }, 30000); // 30 second timeout for API calls
});

/**
 * Fetch trading volume for a specific day by querying the trade history API
 * and summing size * price for all trades within the time range.
 */
async function getVolumeForDay(
    tradingHttpUrl: string,
    subaccountAddr: string,
    nodeApiKey: string,
    startMs: number,
    endMs: number
): Promise<{ volume: number; tradeCount: number }> {
    const fetchPage = async (limit: number, offset: number): Promise<{ items: TradeItem[]; totalCount: number }> => {
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
    };

    let totalVolume = 0;
    let tradeCount = 0;
    let offset = 0;
    const limit = 200;

    // Fetch first page
    const firstPage = await fetchPage(limit, offset);
    for (const item of firstPage.items) {
        if (item.transaction_unix_ms >= startMs && item.transaction_unix_ms < endMs) {
            totalVolume += (item.size ?? 0) * (item.price ?? 0);
            tradeCount++;
        }
    }

    // Paginate if needed
    offset += limit;
    while (offset < firstPage.totalCount) {
        const page = await fetchPage(limit, offset);
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
