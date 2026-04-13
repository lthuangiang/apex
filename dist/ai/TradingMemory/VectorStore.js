"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VectorStore = void 0;
const chromadb_1 = require("chromadb");
class VectorStore {
    client;
    collection = null;
    collectionName = 'trading_memory';
    constructor(chromaUrl = process.env['CHROMA_URL'] ?? 'http://localhost:8000') {
        this.client = new chromadb_1.ChromaClient({ path: chromaUrl });
    }
    async getCollection() {
        if (!this.collection) {
            this.collection = await this.client.getOrCreateCollection({
                name: this.collectionName,
                metadata: { 'hnsw:space': 'cosine' },
            });
        }
        return this.collection;
    }
    async upsert(tradeId, embedding, metadata) {
        const col = await this.getCollection();
        // ChromaDB metadata values must be string | number | boolean
        const flatMeta = {};
        for (const [k, v] of Object.entries(metadata)) {
            if (typeof v === 'object') {
                flatMeta[k] = JSON.stringify(v);
            }
            else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
                flatMeta[k] = v;
            }
        }
        await col.upsert({
            ids: [tradeId],
            embeddings: [embedding],
            metadatas: [flatMeta],
        });
    }
    async query(embedding, n = 10) {
        const col = await this.getCollection();
        const count = await col.count();
        if (count === 0)
            return [];
        const results = await col.query({
            queryEmbeddings: [embedding],
            nResults: Math.min(n, count),
        });
        const metadatas = results.metadatas?.[0] ?? [];
        return metadatas.map(meta => {
            if (!meta)
                return null;
            const signal = typeof meta['signal'] === 'string' ? JSON.parse(meta['signal']) : meta['signal'];
            return {
                tradeId: meta['tradeId'],
                signal,
                decision: meta['decision'],
                pnlPercent: meta['pnlPercent'],
                outcome: meta['outcome'],
                timestamp: meta['timestamp'],
            };
        }).filter((r) => r !== null);
    }
}
exports.VectorStore = VectorStore;
