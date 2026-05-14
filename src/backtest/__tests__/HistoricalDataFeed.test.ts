/**
 * Unit tests for HistoricalDataFeed
 *
 * Requirements: 3.1–3.11, 8.7, 8.8, 8.9, 8.10, 8.11
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { HistoricalDataFeed, SUPPORTED_INTERVALS } from '../HistoricalDataFeed.js';
import { NoDataError, DataFetchError, LoadTimeoutError } from '../types.js';
import type { Kline } from '../../adapters/ExchangeAdapter.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_DATA_DIR = '/tmp/backtest-test-data-' + process.pid;

function makeKline(t: number, c = 100): Kline {
  return { t, o: c - 5, h: c + 5, l: c - 10, c, v: 1000 };
}

function writeJson(filename: string, data: unknown): void {
  fs.writeFileSync(path.join(TEST_DATA_DIR, filename), JSON.stringify(data), 'utf-8');
}

function writeCsv(filename: string, rows: string[]): void {
  fs.writeFileSync(path.join(TEST_DATA_DIR, filename), rows.join('\n'), 'utf-8');
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HistoricalDataFeed', () => {
  describe('listAvailableSymbols()', () => {
    it('returns empty array when data dir does not exist', async () => {
      const feed = new HistoricalDataFeed({ dataDir: '/tmp/nonexistent-dir-xyz' });
      const symbols = await feed.listAvailableSymbols();
      expect(symbols).toEqual([]);
    });

    it('returns empty array when data dir is empty', async () => {
      const feed = new HistoricalDataFeed({ dataDir: TEST_DATA_DIR });
      const symbols = await feed.listAvailableSymbols();
      expect(symbols).toEqual([]);
    });

    it('returns symbols from JSON files', async () => {
      writeJson('BTC-USD_1h.json', []);
      writeJson('ETH-USD_1d.json', []);
      const feed = new HistoricalDataFeed({ dataDir: TEST_DATA_DIR });
      const symbols = await feed.listAvailableSymbols();
      expect(symbols).toContain('BTC-USD');
      expect(symbols).toContain('ETH-USD');
    });

    it('returns symbols from CSV files', async () => {
      writeCsv('SOL-USD_1m.csv', ['t,o,h,l,c,v']);
      const feed = new HistoricalDataFeed({ dataDir: TEST_DATA_DIR });
      const symbols = await feed.listAvailableSymbols();
      expect(symbols).toContain('SOL-USD');
    });

    it('deduplicates symbols that have multiple interval files', async () => {
      writeJson('BTC-USD_1h.json', []);
      writeJson('BTC-USD_1d.json', []);
      const feed = new HistoricalDataFeed({ dataDir: TEST_DATA_DIR });
      const symbols = await feed.listAvailableSymbols();
      const btcCount = symbols.filter(s => s === 'BTC-USD').length;
      expect(btcCount).toBe(1);
    });

    it('ignores files that do not match the naming pattern', async () => {
      fs.writeFileSync(path.join(TEST_DATA_DIR, 'README.md'), 'hello');
      fs.writeFileSync(path.join(TEST_DATA_DIR, 'random.txt'), 'data');
      const feed = new HistoricalDataFeed({ dataDir: TEST_DATA_DIR });
      const symbols = await feed.listAvailableSymbols();
      expect(symbols).toEqual([]);
    });
  });

  describe('listAvailableIntervals()', () => {
    it('returns all supported intervals', () => {
      const feed = new HistoricalDataFeed({ dataDir: TEST_DATA_DIR });
      const intervals = feed.listAvailableIntervals();
      expect(intervals).toEqual(expect.arrayContaining(['1m', '5m', '15m', '1h', '4h', '1d']));
      expect(intervals).toHaveLength(6);
    });
  });

  describe('loadKlines() — local JSON file', () => {
    it('loads klines from a JSON file (Requirement 3.1)', async () => {
      const klines = [
        makeKline(1700000000000),
        makeKline(1700003600000),
        makeKline(1700007200000),
      ];
      writeJson('BTC-USD_1h.json', klines);

      const feed = new HistoricalDataFeed({ dataDir: TEST_DATA_DIR, dataSource: 'local' });
      const from = new Date(1700000000000);
      const to = new Date(1700007200000);
      const result = await feed.loadKlines('BTC-USD', '1h', from, to);

      expect(result).toHaveLength(3);
    });

    it('sorts klines ascending by timestamp (Requirement 3.4)', async () => {
      const klines = [
        makeKline(1700007200000),
        makeKline(1700000000000),
        makeKline(1700003600000),
      ];
      writeJson('BTC-USD_1h.json', klines);

      const feed = new HistoricalDataFeed({ dataDir: TEST_DATA_DIR, dataSource: 'local' });
      const from = new Date(1700000000000);
      const to = new Date(1700007200000);
      const result = await feed.loadKlines('BTC-USD', '1h', from, to);

      expect(result[0].t).toBe(1700000000000);
      expect(result[1].t).toBe(1700003600000);
      expect(result[2].t).toBe(1700007200000);
    });

    it('filters klines to [from, to] inclusive (Requirement 3.5)', async () => {
      const klines = [
        makeKline(1699996400000), // before from
        makeKline(1700000000000), // = from
        makeKline(1700003600000), // between
        makeKline(1700007200000), // = to
        makeKline(1700010800000), // after to
      ];
      writeJson('BTC-USD_1h.json', klines);

      const feed = new HistoricalDataFeed({ dataDir: TEST_DATA_DIR, dataSource: 'local' });
      const from = new Date(1700000000000);
      const to = new Date(1700007200000);
      const result = await feed.loadKlines('BTC-USD', '1h', from, to);

      expect(result).toHaveLength(3);
      expect(result[0].t).toBe(1700000000000);
      expect(result[2].t).toBe(1700007200000);
    });

    it('deduplicates by timestamp, keeping last occurrence (Requirement 3.7)', async () => {
      const klines = [
        { t: 1700000000000, o: 100, h: 110, l: 90, c: 105, v: 1000 },
        { t: 1700003600000, o: 105, h: 115, l: 95, c: 110, v: 1200 }, // first occurrence
        { t: 1700003600000, o: 106, h: 116, l: 96, c: 999, v: 1300 }, // last occurrence — keep this
        { t: 1700007200000, o: 110, h: 120, l: 100, c: 108, v: 900 },
      ];
      writeJson('BTC-USD_1h.json', klines);

      const feed = new HistoricalDataFeed({ dataDir: TEST_DATA_DIR, dataSource: 'local' });
      const from = new Date(1700000000000);
      const to = new Date(1700007200000);
      const result = await feed.loadKlines('BTC-USD', '1h', from, to);

      expect(result).toHaveLength(3);
      const dup = result.find(k => k.t === 1700003600000);
      expect(dup?.c).toBe(999); // last occurrence
    });

    it('throws NoDataError when no data in range (Requirement 3.6)', async () => {
      const klines = [makeKline(1700000000000)];
      writeJson('BTC-USD_1h.json', klines);

      const feed = new HistoricalDataFeed({ dataDir: TEST_DATA_DIR, dataSource: 'local' });
      const from = new Date(9999000000000);
      const to = new Date(9999999999999);

      await expect(feed.loadKlines('BTC-USD', '1h', from, to)).rejects.toThrow(NoDataError);
    });

    it('throws NoDataError when no local file exists (dataSource=local)', async () => {
      const feed = new HistoricalDataFeed({ dataDir: TEST_DATA_DIR, dataSource: 'local' });
      const from = new Date(1700000000000);
      const to = new Date(1700007200000);

      await expect(feed.loadKlines('ETH-USD', '1h', from, to)).rejects.toThrow(NoDataError);
    });

    it('skips malformed records and logs warning (Requirement 3.11)', async () => {
      const klines = [
        { t: 1700000000000, o: 100, h: 110, l: 90, c: 105, v: 1000 }, // valid
        { t: 'bad', o: 'bad', h: 'bad', l: 'bad', c: 'bad', v: 'bad' }, // malformed
        { t: 1700003600000, o: 105, h: 115, l: 95, c: 110, v: 1200 }, // valid
        { missing: 'fields' }, // malformed
        { t: 1700007200000, o: 110, h: 120, l: 100, c: 108, v: 900 }, // valid
      ];
      writeJson('BTC-USD_1h.json', klines);

      const feed = new HistoricalDataFeed({ dataDir: TEST_DATA_DIR, dataSource: 'local' });
      const from = new Date(1700000000000);
      const to = new Date(1700007200000);
      const result = await feed.loadKlines('BTC-USD', '1h', from, to);

      // Only 3 valid records should be returned
      expect(result).toHaveLength(3);
    });
  });

  describe('loadKlines() — local CSV file', () => {
    it('loads klines from a CSV file with header (Requirement 3.1)', async () => {
      writeCsv('BTC-USD_1h.csv', [
        't,o,h,l,c,v',
        '1700000000000,100,110,90,105,1000',
        '1700003600000,105,115,95,110,1200',
        '1700007200000,110,120,100,108,900',
      ]);

      const feed = new HistoricalDataFeed({ dataDir: TEST_DATA_DIR, dataSource: 'local' });
      const from = new Date(1700000000000);
      const to = new Date(1700007200000);
      const result = await feed.loadKlines('BTC-USD', '1h', from, to);

      expect(result).toHaveLength(3);
      expect(result[0].t).toBe(1700000000000);
      expect(result[0].o).toBe(100);
      expect(result[0].c).toBe(105);
    });

    it('loads klines from a CSV file without header', async () => {
      writeCsv('ETH-USD_1h.csv', [
        '1700000000000,100,110,90,105,1000',
        '1700003600000,105,115,95,110,1200',
      ]);

      const feed = new HistoricalDataFeed({ dataDir: TEST_DATA_DIR, dataSource: 'local' });
      const from = new Date(1700000000000);
      const to = new Date(1700007200000);
      const result = await feed.loadKlines('ETH-USD', '1h', from, to);

      expect(result).toHaveLength(2);
    });

    it('skips CSV rows with fewer than 6 columns (Requirement 3.11)', async () => {
      writeCsv('SOL-USD_1h.csv', [
        't,o,h,l,c,v',
        '1700000000000,100,110,90,105,1000', // valid
        '1700003600000,105,115', // malformed — only 3 columns
        '1700007200000,110,120,100,108,900', // valid
      ]);

      const feed = new HistoricalDataFeed({ dataDir: TEST_DATA_DIR, dataSource: 'local' });
      const from = new Date(1700000000000);
      const to = new Date(1700007200000);
      const result = await feed.loadKlines('SOL-USD', '1h', from, to);

      expect(result).toHaveLength(2);
    });

    it('prefers JSON file over CSV when both exist', async () => {
      // JSON has 3 klines, CSV has 2
      writeJson('BTC-USD_1h.json', [
        makeKline(1700000000000),
        makeKline(1700003600000),
        makeKline(1700007200000),
      ]);
      writeCsv('BTC-USD_1h.csv', [
        't,o,h,l,c,v',
        '1700000000000,100,110,90,105,1000',
        '1700003600000,105,115,95,110,1200',
      ]);

      const feed = new HistoricalDataFeed({ dataDir: TEST_DATA_DIR, dataSource: 'local' });
      const from = new Date(1700000000000);
      const to = new Date(1700007200000);
      const result = await feed.loadKlines('BTC-USD', '1h', from, to);

      // Should use JSON (3 klines)
      expect(result).toHaveLength(3);
    });
  });

  describe('loadKlines() — dataSource modes', () => {
    it('dataSource=local throws NoDataError when no local file (Requirement 8.8)', async () => {
      const feed = new HistoricalDataFeed({ dataDir: TEST_DATA_DIR, dataSource: 'local' });
      const from = new Date(1700000000000);
      const to = new Date(1700007200000);

      await expect(feed.loadKlines('BTC-USD', '1h', from, to)).rejects.toThrow(NoDataError);
    });

    it('dataSource=auto uses local data when available (Requirement 8.9)', async () => {
      writeJson('BTC-USD_1h.json', [
        makeKline(1700000000000),
        makeKline(1700003600000),
      ]);

      const feed = new HistoricalDataFeed({ dataDir: TEST_DATA_DIR, dataSource: 'auto' });
      const from = new Date(1700000000000);
      const to = new Date(1700007200000);
      const result = await feed.loadKlines('BTC-USD', '1h', from, to);

      expect(result).toHaveLength(2);
    });
  });

  describe('error classes', () => {
    it('NoDataError has correct name', () => {
      const err = new NoDataError('test');
      expect(err.name).toBe('NoDataError');
      expect(err instanceof NoDataError).toBe(true);
      expect(err instanceof Error).toBe(true);
    });

    it('DataFetchError has correct name and statusCode', () => {
      const err = new DataFetchError('test', 404);
      expect(err.name).toBe('DataFetchError');
      expect(err.statusCode).toBe(404);
      expect(err instanceof DataFetchError).toBe(true);
    });

    it('LoadTimeoutError has correct name', () => {
      const err = new LoadTimeoutError('test');
      expect(err.name).toBe('LoadTimeoutError');
      expect(err instanceof LoadTimeoutError).toBe(true);
    });
  });

  describe('SUPPORTED_INTERVALS', () => {
    it('contains all required intervals (Requirement 3.8)', () => {
      expect(SUPPORTED_INTERVALS).toContain('1m');
      expect(SUPPORTED_INTERVALS).toContain('5m');
      expect(SUPPORTED_INTERVALS).toContain('15m');
      expect(SUPPORTED_INTERVALS).toContain('1h');
      expect(SUPPORTED_INTERVALS).toContain('4h');
      expect(SUPPORTED_INTERVALS).toContain('1d');
    });
  });
});
