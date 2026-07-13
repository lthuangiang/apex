// Feature: ai-alpha-execution-engine, Property 1: SoSoValue response always yields a complete structured object
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';

vi.mock('axios');

// The client keeps module-level caches (fear/greed result + discovered chart name).
// Reset the module registry before each test so state never bleeds across tests.
async function freshClient() {
  vi.resetModules();
  const axios = ((await import('axios')).default as unknown) as { get: ReturnType<typeof vi.fn> };
  const { SoSoValueClient } = await import('./SoSoValueClient.js');
  return { axios, client: new SoSoValueClient() };
}

// Routes GET calls the way the SoSoValue open API is shaped:
//   GET /analyses            → chart discovery list
//   GET /analyses/<chart>    → latest rows for that chart
//   GET alternative.me/fng   → fallback source
function routeGet(handlers: {
  discovery?: unknown;
  chartRows?: unknown;
  fallback?: unknown;
}) {
  return vi.fn((url: string) => {
    if (url.includes('alternative.me')) return Promise.resolve({ data: handlers.fallback });
    if (/\/analyses\/[^/]+/.test(url)) return Promise.resolve({ data: handlers.chartRows });
    if (url.endsWith('/analyses')) return Promise.resolve({ data: handlers.discovery });
    return Promise.resolve({ data: {} });
  });
}

describe('SoSoValueClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SOSOVALUE_API_KEY;
  });

  it('returns null on network error', async () => {
    const { axios, client } = await freshClient();
    axios.get = vi.fn().mockRejectedValue(new Error('Network Error'));
    expect(await client.fetch()).toBeNull();
  });

  it('returns null on timeout', async () => {
    const { axios, client } = await freshClient();
    axios.get = vi.fn().mockRejectedValue(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }));
    expect(await client.fetch()).toBeNull();
  });

  it('falls back to null when the API key is set but discovery finds no fear/greed chart', async () => {
    process.env.SOSOVALUE_API_KEY = 'test-key-123';
    const { axios, client } = await freshClient();
    // Discovery returns unrelated charts, fallback source is unavailable.
    axios.get = routeGet({ discovery: { data: [{ chart_name: 'unrelated_metric' }] }, fallback: {} });
    expect(await client.fetch()).toBeNull();
  });

  it('returns a structured object from the discovered chart on a valid response', async () => {
    process.env.SOSOVALUE_API_KEY = 'test-key-123';
    const { axios, client } = await freshClient();
    axios.get = routeGet({
      discovery: { data: [{ chart_name: 'crypto_fear_greed_index' }] },
      chartRows: { data: [{ value: 65 }] },
    });
    const result = await client.fetch();
    expect(result).toEqual({
      sectorIndex: 65,
      fearGreedIndex: 65,
      fearGreedLabel: 'Greed',
      source: 'sosovalue',
    });
  });

  it('attaches the x-soso-api-key header when SOSOVALUE_API_KEY is set', async () => {
    process.env.SOSOVALUE_API_KEY = 'test-key-123';
    const { axios, client } = await freshClient();
    axios.get = routeGet({
      discovery: { data: [{ chart_name: 'crypto_fear_greed_index' }] },
      chartRows: { data: [{ value: 50 }] },
    });
    await client.fetch();
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('/analyses'),
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-soso-api-key': 'test-key-123' }),
      })
    );
  });

  it('uses the alternative.me fallback (no auth header) when SOSOVALUE_API_KEY is absent', async () => {
    const { axios, client } = await freshClient();
    axios.get = routeGet({ fallback: { data: [{ value: '42', value_classification: 'Fear' }] } });
    const result = await client.fetch();
    expect(result).toEqual({
      sectorIndex: 42,
      fearGreedIndex: 42,
      fearGreedLabel: 'Fear',
      source: 'alternative.me',
    });
    const fallbackCall = axios.get.mock.calls.find(([url]: [string]) => url.includes('alternative.me'));
    expect(fallbackCall).toBeDefined();
    expect(fallbackCall![1]?.headers?.['x-soso-api-key']).toBeUndefined();
  });

  // **Validates: Requirements 1.2**
  // Property 1: any valid fear/greed reading yields a complete structured object
  it('P1: always returns a complete structured object for any valid reading', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 100 }), async (value) => {
        process.env.SOSOVALUE_API_KEY = 'test-key-123';
        const { axios, client } = await freshClient();
        axios.get = routeGet({
          discovery: { data: [{ chart_name: 'crypto_fear_greed_index' }] },
          chartRows: { data: [{ value }] },
        });
        const result = await client.fetch();

        expect(result).not.toBeNull();
        expect(typeof result!.sectorIndex).toBe('number');
        expect(result!.fearGreedIndex).toBe(value);
        expect(typeof result!.fearGreedLabel).toBe('string');
        expect(result!.source).toBe('sosovalue');
      }),
      { numRuns: 50 }
    );
  });
});
