import axios from 'axios';

export interface SoSoValueData {
  sectorIndex: number;
  fearGreedIndex: number;
  fearGreedLabel: string;
}

// Alternative.me Fear & Greed Index — free, no API key, updates daily
const API_URL = 'https://api.alternative.me/fng/?limit=1';

// Cache TTL: 6 hours — data only updates once per day, no quota concerns
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

let cache: { data: SoSoValueData; fetchedAt: number } | null = null;

export class SoSoValueClient {
  async fetch(): Promise<SoSoValueData | null> {
    // Return cached data if still fresh
    if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
      console.log(`[SoSoValueClient] Using cached data (age: ${Math.floor((Date.now() - cache.fetchedAt) / 60000)}m)`);
      return cache.data;
    }

    try {
      const res = await axios.get(API_URL, { timeout: 5000 });
      const entry = res.data?.data?.[0];

      if (!entry) {
        console.error('[SoSoValueClient] Unexpected response shape:', res.data);
        return cache?.data ?? null;
      }

      const fearGreedIndex = Number(entry.value);
      const fearGreedLabel = String(entry.value_classification ?? '');

      if (isNaN(fearGreedIndex)) {
        console.error('[SoSoValueClient] Invalid fear greed value:', entry);
        return cache?.data ?? null;
      }

      // alternative.me doesn't have sectorIndex — use fearGreedIndex as proxy
      const result: SoSoValueData = { sectorIndex: fearGreedIndex, fearGreedIndex, fearGreedLabel };
      cache = { data: result, fetchedAt: Date.now() };
      console.log(`[SoSoValueClient] Fetched: Fear & Greed ${fearGreedIndex} (${fearGreedLabel}), cached 6h`);
      return result;
    } catch (err) {
      console.error('[SoSoValueClient] fetch error:', err);
      if (cache) {
        console.warn(`[SoSoValueClient] Returning stale cache (age: ${Math.floor((Date.now() - cache.fetchedAt) / 3600000)}h)`);
        return cache.data;
      }
      return null;
    }
  }
}
