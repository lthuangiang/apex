/**
 * HistoricalDataFeed — OHLCV data loading and caching for backtesting.
 *
 * Loads klines from local CSV/JSON files or fetches from exchange REST API,
 * caches results, deduplicates, sorts, and filters by date range.
 *
 * Requirements: 3.1–3.11, 8.7, 8.8, 8.9, 8.10, 8.11
 */

import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import type { Kline } from '../adapters/ExchangeAdapter.js';
import { NoDataError, DataFetchError, LoadTimeoutError } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Supported candle intervals. Requirement 3.8, 8.7 */
export const SUPPORTED_INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type SupportedInterval = typeof SUPPORTED_INTERVALS[number];

/** Interval durations in milliseconds. */
const INTERVAL_MS: Record<SupportedInterval, number> = {
  '1m':  60_000,
  '5m':  300_000,
  '15m': 900_000,
  '1h':  3_600_000,
  '4h':  14_400_000,
  '1d':  86_400_000,
};

/** Default directory for local data files. */
const DEFAULT_DATA_DIR = './backtest-data';

/** Load timeout in milliseconds. Requirement 10.4 */
const LOAD_TIMEOUT_MS = 10_000;

/**
 * Exchange REST API base URL for fetching historical klines.
 * Uses SoDEX as the default exchange REST API source.
 * Can be overridden via constructor options.
 */
const DEFAULT_EXCHANGE_API_BASE = 'https://mainnet-gw.sodex.dev/api/v1/perps';

// ---------------------------------------------------------------------------
// HistoricalDataFeedOptions
// ---------------------------------------------------------------------------

export interface HistoricalDataFeedOptions {
  /**
   * Directory to read/write local data files.
   * Defaults to `./backtest-data`.
   */
  dataDir?: string;

  /**
   * Exchange REST API base URL for fetching klines.
   * Defaults to SoDEX mainnet.
   */
  exchangeApiBase?: string;

  /**
   * Data source preference.
   * - `local`        — only use local cached files
   * - `exchange_api` — always fetch from exchange REST API
   * - `auto`         — use local if available, otherwise fetch from API (default)
   * Requirement 8.8–8.11
   */
  dataSource?: 'local' | 'exchange_api' | 'auto';
}

// ---------------------------------------------------------------------------
// HistoricalDataFeed
// ---------------------------------------------------------------------------

/**
 * Loads and caches historical OHLCV klines for backtesting.
 *
 * Requirements: 3.1–3.11, 8.7, 8.8, 8.9, 8.10, 8.11
 */
export class HistoricalDataFeed {
  private readonly dataDir: string;
  private readonly exchangeApiBase: string;
  private readonly dataSource: 'local' | 'exchange_api' | 'auto';

  constructor(options: HistoricalDataFeedOptions = {}) {
    this.dataDir = options.dataDir ?? DEFAULT_DATA_DIR;
    this.exchangeApiBase = options.exchangeApiBase ?? DEFAULT_EXCHANGE_API_BASE;
    this.dataSource = options.dataSource ?? 'auto';
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Load klines for the given symbol and interval within [from, to].
   *
   * - Checks local `./backtest-data/{symbol}_{interval}.csv` or `.json` first
   *   (unless `dataSource === 'exchange_api'`).
   * - Falls back to exchange REST API if no local file found
   *   (unless `dataSource === 'local'`).
   * - Caches fetched data to `./backtest-data/{symbol}_{interval}.json`.
   * - Deduplicates by timestamp (keeps last occurrence).
   * - Sorts ascending by timestamp.
   * - Filters to `from <= t <= to`.
   * - Throws `NoDataError` if no data found from any source.
   * - Throws `DataFetchError` on HTTP error from exchange API.
   * - Throws `LoadTimeoutError` if loading exceeds 10 seconds.
   * - Skips malformed records, logging a warning with the record index.
   *
   * Requirements: 3.1–3.11, 8.8–8.11
   */
  async loadKlines(
    symbol: string,
    interval: string,
    from: Date,
    to: Date,
  ): Promise<Kline[]> {
    const loadPromise = this._loadKlinesInternal(symbol, interval, from, to);

    // Apply 10-second timeout. Requirement 10.4
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new LoadTimeoutError(
          `Loading klines for ${symbol} ${interval} timed out after ${LOAD_TIMEOUT_MS / 1000}s`,
        )),
        LOAD_TIMEOUT_MS,
      ),
    );

    return Promise.race([loadPromise, timeoutPromise]);
  }

  /**
   * Returns the list of symbols with locally cached data files.
   * Scans `./backtest-data/` for files matching `{symbol}_{interval}.json` or `.csv`.
   *
   * Requirement 3.9
   */
  async listAvailableSymbols(): Promise<string[]> {
    const dir = this.dataDir;
    if (!fs.existsSync(dir)) return [];

    const files = fs.readdirSync(dir);
    const symbolSet = new Set<string>();

    for (const file of files) {
      // Match {symbol}_{interval}.json or {symbol}_{interval}.csv
      // Symbol may contain hyphens (e.g. BTC-USD), interval is like 1m, 5m, 1h, 4h, 1d
      const match = file.match(/^(.+)_(1m|5m|15m|1h|4h|1d)\.(json|csv)$/i);
      if (match) {
        symbolSet.add(match[1]);
      }
    }

    return Array.from(symbolSet).sort();
  }

  /**
   * Returns the list of supported intervals.
   * Requirement 3.8
   */
  listAvailableIntervals(): SupportedInterval[] {
    return [...SUPPORTED_INTERVALS];
  }

  // -------------------------------------------------------------------------
  // Internal implementation
  // -------------------------------------------------------------------------

  private async _loadKlinesInternal(
    symbol: string,
    interval: string,
    from: Date,
    to: Date,
  ): Promise<Kline[]> {
    const fromMs = from.getTime();
    const toMs = to.getTime();

    // Determine which sources to try based on dataSource setting
    if (this.dataSource === 'local') {
      // Only try local files. Requirement 8.8
      const klines = await this._tryLoadLocal(symbol, interval);
      if (klines !== null) {
        return this._processKlines(klines, fromMs, toMs, symbol, interval);
      }
      throw new NoDataError(
        `No local data found for ${symbol} ${interval} in ${this.dataDir}. ` +
        `Please provide a local file or switch dataSource to 'auto' or 'exchange_api'.`,
      );
    }

    if (this.dataSource === 'exchange_api') {
      // Only fetch from exchange API. Requirement 8.8
      const klines = await this._fetchFromExchangeApi(symbol, interval, from, to);
      await this._cacheToFile(symbol, interval, klines);
      return this._processKlines(klines, fromMs, toMs, symbol, interval);
    }

    // dataSource === 'auto': try local first, then exchange API. Requirements 8.9, 8.10, 8.11
    const localKlines = await this._tryLoadLocal(symbol, interval);
    if (localKlines !== null) {
      // Requirement 8.9: use local data if available
      return this._processKlines(localKlines, fromMs, toMs, symbol, interval);
    }

    // No local data — fetch from exchange API. Requirement 8.10
    let apiKlines: Kline[];
    try {
      apiKlines = await this._fetchFromExchangeApi(symbol, interval, from, to);
    } catch (err) {
      if (err instanceof DataFetchError) {
        // Requirement 8.11: both sources failed
        throw new NoDataError(
          `No data available for ${symbol} ${interval} from ${from.toISOString()} to ${to.toISOString()}. ` +
          `Local file not found and exchange API returned an error: ${err.message}`,
        );
      }
      throw err;
    }

    // Cache the fetched data. Requirement 3.3
    await this._cacheToFile(symbol, interval, apiKlines);

    return this._processKlines(apiKlines, fromMs, toMs, symbol, interval);
  }

  /**
   * Try to load klines from a local file.
   * Returns `null` if no file exists.
   * Requirement 3.1
   */
  private async _tryLoadLocal(symbol: string, interval: string): Promise<Kline[] | null> {
    const jsonPath = this._localFilePath(symbol, interval, 'json');
    const csvPath = this._localFilePath(symbol, interval, 'csv');

    if (fs.existsSync(jsonPath)) {
      return this._parseJsonFile(jsonPath);
    }

    if (fs.existsSync(csvPath)) {
      return this._parseCsvFile(csvPath);
    }

    return null;
  }

  /**
   * Parse a JSON file containing klines.
   * Skips malformed records. Requirement 3.11
   */
  private _parseJsonFile(filePath: string): Kline[] {
    const raw = fs.readFileSync(filePath, 'utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn(`[HistoricalDataFeed] Failed to parse JSON file: ${filePath}`);
      return [];
    }

    if (!Array.isArray(parsed)) {
      console.warn(`[HistoricalDataFeed] JSON file does not contain an array: ${filePath}`);
      return [];
    }

    const klines: Kline[] = [];
    for (let i = 0; i < parsed.length; i++) {
      const record = parsed[i];
      const kline = this._parseRecord(record, i);
      if (kline !== null) {
        klines.push(kline);
      }
    }
    return klines;
  }

  /**
   * Parse a CSV file containing klines.
   * Expected columns: t,o,h,l,c,v (with optional header row).
   * Skips malformed records. Requirement 3.11
   */
  private _parseCsvFile(filePath: string): Kline[] {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const lines = raw.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    const klines: Kline[] = [];
    let startIndex = 0;

    // Detect and skip header row
    if (lines.length > 0) {
      const firstLine = lines[0].toLowerCase();
      if (firstLine.includes('t') || firstLine.includes('open') || firstLine.includes('timestamp')) {
        startIndex = 1;
      }
    }

    for (let i = startIndex; i < lines.length; i++) {
      const parts = lines[i].split(',').map(p => p.trim());
      if (parts.length < 6) {
        console.warn(
          `[HistoricalDataFeed] Skipping malformed CSV record at index ${i}: ` +
          `expected 6 columns (t,o,h,l,c,v), got ${parts.length}`,
        );
        continue;
      }

      const record = {
        t: parts[0],
        o: parts[1],
        h: parts[2],
        l: parts[3],
        c: parts[4],
        v: parts[5],
      };

      const kline = this._parseRecord(record, i);
      if (kline !== null) {
        klines.push(kline);
      }
    }
    return klines;
  }

  /**
   * Parse a single record (object or array) into a Kline.
   * Returns `null` and logs a warning if the record is malformed.
   * Requirement 3.11
   */
  private _parseRecord(record: unknown, index: number): Kline | null {
    if (record === null || typeof record !== 'object') {
      console.warn(`[HistoricalDataFeed] Skipping malformed record at index ${index}: not an object`);
      return null;
    }

    const r = record as Record<string, unknown>;

    // Support both lowercase (t,o,h,l,c,v) and uppercase/alternative field names
    const t = this._toNumber(r['t'] ?? r['timestamp'] ?? r['time'] ?? r['openTime']);
    const o = this._toNumber(r['o'] ?? r['open']);
    const h = this._toNumber(r['h'] ?? r['high']);
    const l = this._toNumber(r['l'] ?? r['low']);
    const c = this._toNumber(r['c'] ?? r['close']);
    const v = this._toNumber(r['v'] ?? r['volume']);

    if (t === null || o === null || h === null || l === null || c === null || v === null) {
      const missing: string[] = [];
      if (t === null) missing.push('t');
      if (o === null) missing.push('o');
      if (h === null) missing.push('h');
      if (l === null) missing.push('l');
      if (c === null) missing.push('c');
      if (v === null) missing.push('v');
      console.warn(
        `[HistoricalDataFeed] Skipping malformed record at index ${index}: ` +
        `missing or non-numeric fields: ${missing.join(', ')}`,
      );
      return null;
    }

    return { t, o, h, l, c, v };
  }

  /**
   * Convert a value to a number, returning `null` if it's not a valid finite number.
   */
  private _toNumber(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    if (!isFinite(n)) return null;
    return n;
  }

  /**
   * Fetch klines from the exchange REST API.
   * Throws `DataFetchError` on HTTP error. Requirement 3.10
   */
  private async _fetchFromExchangeApi(
    symbol: string,
    interval: string,
    from: Date,
    to: Date,
  ): Promise<Kline[]> {
    // Calculate how many candles we need
    const intervalMs = INTERVAL_MS[interval as SupportedInterval] ?? INTERVAL_MS['1h'];
    const rangeMs = to.getTime() - from.getTime();
    const limit = Math.min(Math.ceil(rangeMs / intervalMs) + 1, 1500);

    const url = `${this.exchangeApiBase}/markets/${encodeURIComponent(symbol)}/klines`;
    const params = {
      interval,
      limit,
    };

    console.log(`[HistoricalDataFeed] Fetching klines from exchange API: ${url}`, params);

    try {
      const response = await axios.get(url, {
        params,
        timeout: LOAD_TIMEOUT_MS,
      });

      const data = response.data;
      // Handle wrapped response: { data: [...] } or direct array
      const arr: unknown[] = Array.isArray(data)
        ? data
        : Array.isArray(data?.data)
          ? data.data
          : [];

      if (arr.length === 0) {
        throw new NoDataError(
          `Exchange API returned no klines for ${symbol} ${interval} ` +
          `from ${from.toISOString()} to ${to.toISOString()}. ` +
          `Try using local data or a different date range.`,
        );
      }

      const klines: Kline[] = [];
      for (let i = 0; i < arr.length; i++) {
        const kline = this._parseRecord(arr[i], i);
        if (kline !== null) {
          klines.push(kline);
        }
      }

      return klines;
    } catch (err: unknown) {
      if (err instanceof NoDataError) throw err;

      // Axios HTTP error
      if (axios.isAxiosError(err)) {
        const status = err.response?.status ?? 0;
        throw new DataFetchError(
          `Exchange API HTTP error ${status} for ${symbol} ${interval}: ${err.message}. ` +
          `Please retry or provide local data in ${this.dataDir}/.`,
          status,
        );
      }

      // Re-throw other errors (e.g. network timeout)
      throw err;
    }
  }

  /**
   * Cache klines to a local JSON file.
   * Requirement 3.3
   */
  private async _cacheToFile(symbol: string, interval: string, klines: Kline[]): Promise<void> {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }
      const filePath = this._localFilePath(symbol, interval, 'json');
      fs.writeFileSync(filePath, JSON.stringify(klines, null, 2), 'utf-8');
      console.log(`[HistoricalDataFeed] Cached ${klines.length} klines to ${filePath}`);
    } catch (err) {
      // Non-fatal: log warning but don't fail the load
      console.warn(`[HistoricalDataFeed] Failed to cache klines to disk:`, err);
    }
  }

  /**
   * Deduplicate, sort, and filter klines.
   * - Deduplicates by timestamp (keeps last occurrence). Requirement 3.7
   * - Sorts ascending by timestamp. Requirement 3.4
   * - Filters to `from <= t <= to`. Requirement 3.5
   * - Throws `NoDataError` if result is empty. Requirement 3.6
   */
  private _processKlines(
    klines: Kline[],
    fromMs: number,
    toMs: number,
    symbol: string,
    interval: string,
  ): Kline[] {
    // Deduplicate by timestamp — keep last occurrence. Requirement 3.7
    const byTimestamp = new Map<number, Kline>();
    for (const kline of klines) {
      byTimestamp.set(kline.t, kline);
    }

    // Sort ascending by timestamp. Requirement 3.4
    const sorted = Array.from(byTimestamp.values()).sort((a, b) => a.t - b.t);

    // Filter to [from, to] inclusive. Requirement 3.5
    const filtered = sorted.filter(k => k.t >= fromMs && k.t <= toMs);

    // Throw NoDataError if no data found. Requirement 3.6
    if (filtered.length === 0) {
      throw new NoDataError(
        `No klines found for ${symbol} ${interval} ` +
        `from ${new Date(fromMs).toISOString()} to ${new Date(toMs).toISOString()}. ` +
        `The local file or exchange API returned data outside the requested range.`,
      );
    }

    return filtered;
  }

  /**
   * Build the local file path for a given symbol, interval, and extension.
   */
  private _localFilePath(symbol: string, interval: string, ext: 'json' | 'csv'): string {
    // Sanitize symbol for use in filename (replace / with -)
    const safeSymbol = symbol.replace(/\//g, '-');
    return path.join(this.dataDir, `${safeSymbol}_${interval}.${ext}`);
  }
}
