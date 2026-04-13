import { ChromaClient, type Collection } from 'chromadb';
import type { TradeRecord } from './types.js';

export class VectorStore {
  private client: ChromaClient | null = null;
  private collection: Collection | null = null;
  private readonly collectionName = 'trading_memory';
  private readonly enabled: boolean;

  constructor(chromaUrl: string = process.env['CHROMA_URL'] ?? '') {
    this.enabled = !!chromaUrl;
    if (this.enabled) {
      this.client = new ChromaClient({ path: chromaUrl });
    } else {
      console.warn('[VectorStore] CHROMA_URL not set — vector memory disabled');
    }
  }

  private async getCollection(): Promise<Collection> {
    if (!this.client) throw new Error('VectorStore disabled: no CHROMA_URL');
    if (!this.collection) {
      this.collection = await this.client.getOrCreateCollection({
        name: this.collectionName,
        metadata: { 'hnsw:space': 'cosine' },
      });
    }
    return this.collection;
  }

  async upsert(tradeId: string, embedding: number[], metadata: Record<string, unknown>): Promise<void> {
    if (!this.enabled) return; // silently skip when disabled
    const col = await this.getCollection();
    // ChromaDB metadata values must be string | number | boolean
    const flatMeta: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(metadata)) {
      if (typeof v === 'object') {
        flatMeta[k] = JSON.stringify(v);
      } else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        flatMeta[k] = v;
      }
    }
    await col.upsert({
      ids: [tradeId],
      embeddings: [embedding],
      metadatas: [flatMeta],
    });
  }

  async query(embedding: number[], n: number = 10): Promise<TradeRecord[]> {
    if (!this.enabled) return [];
    const col = await this.getCollection();
    const count = await col.count();
    if (count === 0) return [];

    const results = await col.query({
      queryEmbeddings: [embedding],
      nResults: Math.min(n, count),
    });

    const metadatas = results.metadatas?.[0] ?? [];
    return metadatas.map(meta => {
      if (!meta) return null;
      const signal = typeof meta['signal'] === 'string' ? JSON.parse(meta['signal']) : meta['signal'];
      return {
        tradeId: meta['tradeId'] as string,
        signal,
        decision: meta['decision'] as TradeRecord['decision'],
        pnlPercent: meta['pnlPercent'] as number,
        outcome: meta['outcome'] as 'WIN' | 'LOSS',
        timestamp: meta['timestamp'] as string,
      } satisfies TradeRecord;
    }).filter((r): r is TradeRecord => r !== null);
  }
}
