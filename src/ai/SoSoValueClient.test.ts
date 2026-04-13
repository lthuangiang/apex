// Feature: ai-alpha-execution-engine, Property 1: SoSoValue response always yields a complete structured object
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import axios from 'axios';

vi.mock('axios');
const mockedAxios = axios as unknown as { get: ReturnType<typeof vi.fn> };

import { SoSoValueClient } from './SoSoValueClient.js';

describe('SoSoValueClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Unit tests
  it('returns null on network error', async () => {
    mockedAxios.get = vi.fn().mockRejectedValue(new Error('Network Error'));
    const client = new SoSoValueClient();
    const result = await client.fetch();
    expect(result).toBeNull();
  });

  it('returns null on timeout', async () => {
    const err = Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
    mockedAxios.get = vi.fn().mockRejectedValue(err);
    const client = new SoSoValueClient();
    const result = await client.fetch();
    expect(result).toBeNull();
  });

  it('returns null when response fields are missing/NaN', async () => {
    mockedAxios.get = vi.fn().mockResolvedValue({ data: { unrelated: 'field' } });
    const client = new SoSoValueClient();
    const result = await client.fetch();
    expect(result).toBeNull();
  });

  it('returns correct fields on a valid response', async () => {
    mockedAxios.get = vi.fn().mockResolvedValue({
      data: { sectorIndex: 42, fearGreedIndex: 75, fearGreedLabel: 'Greed' },
    });
    const client = new SoSoValueClient();
    const result = await client.fetch();
    expect(result).toEqual({ sectorIndex: 42, fearGreedIndex: 75, fearGreedLabel: 'Greed' });
  });

  it('attaches Authorization header when SOSOVALUE_API_KEY is set', async () => {
    process.env.SOSOVALUE_API_KEY = 'test-key-123';
    mockedAxios.get = vi.fn().mockResolvedValue({
      data: { sectorIndex: 1, fearGreedIndex: 50, fearGreedLabel: 'Neutral' },
    });
    const client = new SoSoValueClient();
    await client.fetch();
    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-key-123' }),
      })
    );
    delete process.env.SOSOVALUE_API_KEY;
  });

  it('does not attach Authorization header when SOSOVALUE_API_KEY is absent', async () => {
    delete process.env.SOSOVALUE_API_KEY;
    mockedAxios.get = vi.fn().mockResolvedValue({
      data: { sectorIndex: 1, fearGreedIndex: 50, fearGreedLabel: 'Neutral' },
    });
    const client = new SoSoValueClient();
    await client.fetch();
    const callArgs = mockedAxios.get.mock.calls[0][1];
    expect(callArgs.headers?.Authorization).toBeUndefined();
  });

  // **Validates: Requirements 1.2**
  // Property 1: SoSoValue response always yields a complete structured object
  it('P1: always returns complete structured object for any valid API response', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          sectorIndex: fc.float({ noNaN: true }),
          fearGreedIndex: fc.float({ noNaN: true }),
          fearGreedLabel: fc.string(),
        }),
        async (payload) => {
          mockedAxios.get = vi.fn().mockResolvedValue({ data: payload });
          const client = new SoSoValueClient();
          const result = await client.fetch();

          expect(result).not.toBeNull();
          expect(typeof result!.sectorIndex).toBe('number');
          expect(typeof result!.fearGreedIndex).toBe('number');
          expect(typeof result!.fearGreedLabel).toBe('string');
        }
      ),
      { numRuns: 100 }
    );
  });
});
