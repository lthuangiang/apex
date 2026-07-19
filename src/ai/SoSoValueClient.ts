import axios from 'axios';

const BASE_URL = 'https://openapi.sosovalue.com/openapi/v1';

// ── Public interfaces ─────────────────────────────────────────────────────────

export interface SoSoValueData {
  sectorIndex: number;
  fearGreedIndex: number;
  fearGreedLabel: string;
  source: 'sosovalue' | 'alternative.me';
}

export interface SoSoChartMeta {
  name: string;
  fields: string[];
}

export type EtfFlowSignal = 'strong_bull' | 'bull' | 'neutral' | 'bear' | 'strong_bear';

export interface EtfFlowData {
  btcNetInflowToday: number;   // USD
  btcNetInflow3d: number;      // USD — sum of last 3 days
  signal: EtfFlowSignal;
  source: 'sosovalue';
}

export interface MacroEvent {
  date: string;   // YYYY-MM-DD
  name: string;
  impact: 'high' | 'medium' | 'low';
}

export interface MacroRisk {
  hasHighImpactToday: boolean;
  hasHighImpactTomorrow: boolean;
  events: MacroEvent[];
  riskLevel: 'none' | 'elevated' | 'high';
  sizeMultiplier: number;
  confidenceMultiplier: number;
  reason: string;
}

// ── SSI / Sector types ────────────────────────────────────────────────────────

export type SectorTrend = 'hot' | 'neutral' | 'cold';

export interface SsiIndexData {
  /** Composite SSI index value (weighted avg of sector indices, 0-100 scale) */
  compositeScore: number;
  /** 24h percentage change of the composite index */
  change24h: number;
  /** Trend interpretation */
  trend: SectorTrend;
  source: 'sosovalue' | 'derived';
}

export interface SectorRotationData {
  /** Which sector is leading (highest 24h % gain) */
  leadingSector: string;
  /** Which sector is lagging (lowest 24h % gain) */
  laggingSector: string;
  /** Sector performance map: sector name → 24h % change */
  sectorPerformance: Record<string, number>;
  /** Rotation signal: if DeFi/L1 leading → risk-on; if stablecoins leading → risk-off */
  signal: 'risk_on' | 'neutral' | 'risk_off';
  source: 'sosovalue' | 'derived';
}

// ── Internal cache ────────────────────────────────────────────────────────────

let _fearGreedChartName: string | null = null;

let _fearGreedCache: { data: SoSoValueData; fetchedAt: number } | null = null;
const FEAR_GREED_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

let _etfCache: { data: EtfFlowData; fetchedAt: number } | null = null;
const ETF_CACHE_TTL = 4 * 60 * 60 * 1000;

let _macroCache: { data: MacroRisk; fetchedAt: number } | null = null;
const MACRO_CACHE_TTL = 60 * 60 * 1000; // 1 hour

let _ssiCache: { data: SsiIndexData; fetchedAt: number } | null = null;
const SSI_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

let _sectorCache: { data: SectorRotationData; fetchedAt: number } | null = null;
const SECTOR_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

// ── Helpers ───────────────────────────────────────────────────────────────────

function _labelFromIndex(index: number): string {
  if (index < 25) return 'Extreme Fear';
  if (index < 45) return 'Fear';
  if (index < 55) return 'Neutral';
  if (index < 75) return 'Greed';
  return 'Extreme Greed';
}

function _authHeaders(apiKey: string) {
  return { 'x-soso-api-key': apiKey };
}

function _etfSignalFromInflow(todayInflow: number, inflow3d: number): EtfFlowSignal {
  if (inflow3d < -300e6) return 'strong_bear';
  if (todayInflow > 500e6)  return 'strong_bull';
  if (todayInflow > 100e6)  return 'bull';
  if (todayInflow < -300e6) return 'strong_bear';
  if (todayInflow < -100e6) return 'bear';
  return 'neutral';
}

const HIGH_IMPACT_KEYWORDS = ['fomc', 'federal reserve', 'cpi', 'nfp', 'non-farm', 'nonfarm', 'pce', 'gdp', 'ppi'];
const MEDIUM_IMPACT_KEYWORDS = ['jobless claims', 'retail sales', 'pmi', 'ism', 'unemployment'];

function _classifyImpact(eventName: string): 'high' | 'medium' | 'low' {
  const lower = eventName.toLowerCase();
  if (HIGH_IMPACT_KEYWORDS.some(k => lower.includes(k))) return 'high';
  if (MEDIUM_IMPACT_KEYWORDS.some(k => lower.includes(k))) return 'medium';
  return 'low';
}

function _todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function _tomorrowStr(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

// ── SoSoValueClient ───────────────────────────────────────────────────────────

export class SoSoValueClient {

  /**
   * Fetch Fear & Greed Index.
   * Uses /analyses endpoint to discover chart name, then fetches latest data.
   * Falls back to alternative.me if no API key or on error.
   */
  async fetch(): Promise<SoSoValueData | null> {
    // Check cache first
    if (_fearGreedCache && Date.now() - _fearGreedCache.fetchedAt < FEAR_GREED_CACHE_TTL) {
      return _fearGreedCache.data;
    }

    const API_KEY = process.env.SOSOVALUE_API_KEY;

    if (!API_KEY) {
      console.warn('[SoSoValueClient] No SOSOVALUE_API_KEY set — using alternative.me fallback');
      return this._fetchFallback();
    }

    try {
      const chartName = await this._discoverFearGreedChart(API_KEY);
      if (!chartName) {
        console.warn('[SoSoValueClient] Fear & Greed chart not found in /analyses — using fallback');
        return this._fetchFallback();
      }

      const rows = await this.fetchChart(chartName, 1);
      if (!rows || rows.length === 0) {
        console.warn('[SoSoValueClient] Empty response from /analyses/' + chartName + ' — using fallback');
        return this._fetchFallback();
      }

      const fearGreedIndex = this._extractNumericValue(rows[0]);
      if (fearGreedIndex === null) {
        console.warn('[SoSoValueClient] Cannot parse Fear & Greed value from row:', rows[0]);
        return this._fetchFallback();
      }

      const fearGreedLabel = _labelFromIndex(fearGreedIndex);
      const result: SoSoValueData = { sectorIndex: fearGreedIndex, fearGreedIndex, fearGreedLabel, source: 'sosovalue' };

      // Cache the result
      _fearGreedCache = { data: result, fetchedAt: Date.now() };

      console.log(`[SoSoValueClient] ✅ Fear & Greed ${fearGreedIndex} (${fearGreedLabel}) — source: sosovalue`);
      return result;

    } catch (err: any) {
      console.warn('[SoSoValueClient] SoSoValue API error, falling back to alternative.me:', err.message);
      return this._fetchFallback();
    }
  }

  /**
   * Fetch BTC ETF net inflow data. GET /etfs/summary-history?symbol=BTC&limit=3
   * Cached 4 hours. Returns null on error.
   */
  async fetchEtfFlow(): Promise<EtfFlowData | null> {
    const API_KEY = process.env.SOSOVALUE_API_KEY;
    if (!API_KEY) return null;

    if (_etfCache && Date.now() - _etfCache.fetchedAt < ETF_CACHE_TTL) return _etfCache.data;

    try {
      const url = `${BASE_URL}/etfs/summary-history`;
      const params = { symbol: 'BTC', limit: 3, country_code: 'US' };

      console.log(`[SoSoValueClient] ETF Flow request: ${url}`, params);

      const res = await axios.get(url, {
        headers: _authHeaders(API_KEY),
        params,
        timeout: 8000,
      });

      console.log(`[SoSoValueClient] ETF Flow response status: ${res.status}`);
      console.log(`[SoSoValueClient] ETF Flow response data:`, JSON.stringify(res.data, null, 2).slice(0, 500));

      const rows: any[] = res.data?.data ?? [];
      if (rows.length === 0) { console.warn('[SoSoValueClient] ETF summary-history empty'); return null; }

      const todayRow = rows[0];
      const btcNetInflowToday = Number(todayRow.net_inflow ?? todayRow.netInflow ?? todayRow.net_flow ?? 0);
      const btcNetInflow3d = rows.reduce((s: number, r: any) => s + Number(r.net_inflow ?? r.netInflow ?? r.net_flow ?? 0), 0);
      const signal = _etfSignalFromInflow(btcNetInflowToday, btcNetInflow3d);
      const data: EtfFlowData = { btcNetInflowToday, btcNetInflow3d, signal, source: 'sosovalue' };
      _etfCache = { data, fetchedAt: Date.now() };

      const fmt = (v: number) => { const a = Math.abs(v); const s = v >= 0 ? '+' : '-'; return a >= 1e9 ? `${s}$${(a/1e9).toFixed(2)}B` : `${s}$${(a/1e6).toFixed(0)}M`; };
      console.log(`[SoSoValueClient] ✅ BTC ETF inflow today: ${fmt(btcNetInflowToday)}, 3d: ${fmt(btcNetInflow3d)} → ${signal}`);
      return data;

    } catch (err: any) {
      console.error('[SoSoValueClient] ETF flow fetch error:', err.message);
      if (err.response) {
        console.error('[SoSoValueClient] ETF error response status:', err.response.status);
        console.error('[SoSoValueClient] ETF error response data:', JSON.stringify(err.response.data, null, 2));
      }
      return null;
    }
  }

  /**
   * Fetch macro events for today and tomorrow from SoSoValue.
   * GET /macro/events — returns calendar of economic events.
   * Cached 1 hour. Returns safe default (riskLevel: 'none') on error.
   */
  async fetchMacroEvents(): Promise<MacroRisk> {
    const SAFE_DEFAULT: MacroRisk = {
      hasHighImpactToday: false, hasHighImpactTomorrow: false,
      events: [], riskLevel: 'none', sizeMultiplier: 1.0, confidenceMultiplier: 1.0, reason: 'No macro data',
    };

    const API_KEY = process.env.SOSOVALUE_API_KEY;
    if (!API_KEY) return SAFE_DEFAULT;

    if (_macroCache && Date.now() - _macroCache.fetchedAt < MACRO_CACHE_TTL) return _macroCache.data;

    try {
      const res = await axios.get(`${BASE_URL}/macro/events`, {
        headers: _authHeaders(API_KEY),
        timeout: 8000,
      });

      const rawEvents: any[] = res.data?.data ?? [];
      const today = _todayStr();
      const tomorrow = _tomorrowStr();

      const events: MacroEvent[] = [];
      for (const entry of rawEvents) {
        const date = String(entry.date ?? entry.event_date ?? '');
        if (date !== today && date !== tomorrow) continue;
        const names: string[] = Array.isArray(entry.events) ? entry.events : [String(entry.name ?? entry.event ?? '')];
        for (const name of names) {
          if (!name) continue;
          events.push({ date, name, impact: _classifyImpact(name) });
        }
      }

      const highToday = events.some(e => e.date === today && e.impact === 'high');
      const highTomorrow = events.some(e => e.date === tomorrow && e.impact === 'high');

      let riskLevel: MacroRisk['riskLevel'] = 'none';
      let sizeMultiplier = 1.0;
      let confidenceMultiplier = 1.0;
      let reason = 'No high-impact events';

      if (highToday) {
        riskLevel = 'high';
        sizeMultiplier = 0.3;
        confidenceMultiplier = 2.0;
        const names = events.filter(e => e.date === today && e.impact === 'high').map(e => e.name).join(', ');
        reason = `HIGH RISK: ${names} today`;
        console.warn(`[MacroGuard] 🔴 ${reason} — size reduced to 30%`);
      } else if (highTomorrow) {
        riskLevel = 'elevated';
        sizeMultiplier = 0.6;
        confidenceMultiplier = 1.5;
        const names = events.filter(e => e.date === tomorrow && e.impact === 'high').map(e => e.name).join(', ');
        reason = `ELEVATED: ${names} tomorrow`;
        console.warn(`[MacroGuard] 🟡 ${reason} — size reduced to 60%`);
      } else {
        console.log(`[MacroGuard] ✅ No high-impact events today/tomorrow`);
      }

      const data: MacroRisk = { hasHighImpactToday: highToday, hasHighImpactTomorrow: highTomorrow, events, riskLevel, sizeMultiplier, confidenceMultiplier, reason };
      _macroCache = { data, fetchedAt: Date.now() };
      return data;

    } catch (err: any) {
      console.warn('[SoSoValueClient] Macro events fetch error:', err.message);
      return SAFE_DEFAULT;
    }
  }

  /**
   * Fetch SSI (SoSoValue Sector Index) composite score.
   * Uses the sector index charts to compute a market-wide sentiment composite.
   * Cached 15 minutes.
   */
  async fetchSsiIndex(): Promise<SsiIndexData | null> {
    const API_KEY = process.env.SOSOVALUE_API_KEY;
    if (!API_KEY) return this._deriveSsiFromFearGreed();

    if (_ssiCache && Date.now() - _ssiCache.fetchedAt < SSI_CACHE_TTL) return _ssiCache.data;

    try {
      // Attempt to fetch sector index data from SoSoValue analyses
      // Try common chart names for sector/SSI data
      const chartNames = ['ssi_index', 'sector_index', 'crypto_sector_performance', 'market_sector_index'];
      let rows: Record<string, unknown>[] | null = null;

      for (const name of chartNames) {
        rows = await this.fetchChart(name, 2);
        if (rows && rows.length > 0) break;
      }

      if (rows && rows.length >= 1) {
        const latest = rows[0] as any;
        const previous = rows.length > 1 ? rows[1] as any : null;

        const currentValue = Number(latest.value ?? latest.index ?? latest.score ?? 50);
        const previousValue = previous ? Number(previous.value ?? previous.index ?? previous.score ?? currentValue) : currentValue;
        const change24h = previousValue > 0 ? ((currentValue - previousValue) / previousValue) * 100 : 0;

        const trend: SectorTrend = change24h > 2 ? 'hot' : change24h < -2 ? 'cold' : 'neutral';

        const data: SsiIndexData = {
          compositeScore: Math.min(100, Math.max(0, currentValue)),
          change24h,
          trend,
          source: 'sosovalue',
        };

        _ssiCache = { data, fetchedAt: Date.now() };
        console.log(`[SoSoValueClient] ✅ SSI Index: ${data.compositeScore.toFixed(1)} (${change24h >= 0 ? '+' : ''}${change24h.toFixed(2)}%) → ${trend}`);
        return data;
      }

      // Fallback: derive from Fear & Greed + funding rate combo
      return this._deriveSsiFromFearGreed();
    } catch (err: any) {
      console.warn('[SoSoValueClient] SSI fetch error:', err.message);
      return this._deriveSsiFromFearGreed();
    }
  }

  /**
   * Fetch sector rotation signal.
   * Determines which crypto sectors are leading/lagging to detect risk-on/risk-off flows.
   * Cached 15 minutes.
   */
  async fetchSectorRotation(): Promise<SectorRotationData | null> {
    const API_KEY = process.env.SOSOVALUE_API_KEY;
    if (!API_KEY) return this._deriveSectorRotation();

    if (_sectorCache && Date.now() - _sectorCache.fetchedAt < SECTOR_CACHE_TTL) return _sectorCache.data;

    try {
      // Fetch multiple sector charts to compare performance
      const sectors = ['defi', 'meme', 'layer1', 'layer2', 'ai_crypto', 'gamefi'];
      const sectorPerformance: Record<string, number> = {};

      const results = await Promise.allSettled(
        sectors.map(async (sector) => {
          // Try multiple chart name patterns
          const names = [`${sector}_sector_mcap`, `${sector}_market_cap`, `sector_${sector}`];
          for (const name of names) {
            const rows = await this.fetchChart(name, 2);
            if (rows && rows.length >= 2) {
              const latest = Number((rows[0] as any).value ?? (rows[0] as any).mcap ?? 0);
              const previous = Number((rows[1] as any).value ?? (rows[1] as any).mcap ?? 0);
              if (previous > 0) {
                return { sector, change: ((latest - previous) / previous) * 100 };
              }
            }
          }
          return null;
        })
      );

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          sectorPerformance[result.value.sector] = result.value.change;
        }
      }

      // If we got any sector data, compute rotation signal
      if (Object.keys(sectorPerformance).length >= 2) {
        const sorted = Object.entries(sectorPerformance).sort((a, b) => b[1] - a[1]);
        const leading = sorted[0];
        const lagging = sorted[sorted.length - 1];

        // Risk-on = DeFi/L1/AI leading; Risk-off = stablecoins or everything red
        const riskOnSectors = ['defi', 'layer1', 'ai_crypto', 'gamefi'];
        const signal: SectorRotationData['signal'] =
          riskOnSectors.includes(leading[0]) && leading[1] > 1 ? 'risk_on' :
          leading[1] < -1 ? 'risk_off' : 'neutral';

        const data: SectorRotationData = {
          leadingSector: leading[0],
          laggingSector: lagging[0],
          sectorPerformance,
          signal,
          source: 'sosovalue',
        };

        _sectorCache = { data, fetchedAt: Date.now() };
        console.log(`[SoSoValueClient] ✅ Sector Rotation: leading=${leading[0]} (${leading[1].toFixed(1)}%) | signal=${signal}`);
        return data;
      }

      return this._deriveSectorRotation();
    } catch (err: any) {
      console.warn('[SoSoValueClient] Sector rotation fetch error:', err.message);
      return this._deriveSectorRotation();
    }
  }

  /**
   * Derive SSI from Fear & Greed as fallback when API charts unavailable.
   */
  private _deriveSsiFromFearGreed(): SsiIndexData | null {
    const fg = _fearGreedCache?.data;
    if (!fg) return null;

    // Map Fear & Greed to a 0-100 composite (same scale but inverted for "sector health")
    // FG < 25 = cold sectors, FG > 60 = hot sectors
    const score = fg.fearGreedIndex;
    const trend: SectorTrend = score > 60 ? 'hot' : score < 30 ? 'cold' : 'neutral';
    const data: SsiIndexData = {
      compositeScore: score,
      change24h: 0,
      trend,
      source: 'derived',
    };
    _ssiCache = { data, fetchedAt: Date.now() };
    return data;
  }

  /**
   * Derive sector rotation from ETF flow + funding rate as fallback.
   */
  private _deriveSectorRotation(): SectorRotationData | null {
    const etf = _etfCache?.data;
    if (!etf) return null;

    // ETF inflows = institutional risk-on → DeFi/L1 likely leading
    // ETF outflows = risk-off → everything lagging
    const signal: SectorRotationData['signal'] =
      etf.signal === 'strong_bull' || etf.signal === 'bull' ? 'risk_on' :
      etf.signal === 'strong_bear' || etf.signal === 'bear' ? 'risk_off' : 'neutral';

    const data: SectorRotationData = {
      leadingSector: signal === 'risk_on' ? 'defi' : signal === 'risk_off' ? 'stablecoins' : 'mixed',
      laggingSector: signal === 'risk_on' ? 'stablecoins' : signal === 'risk_off' ? 'meme' : 'mixed',
      sectorPerformance: {},
      signal,
      source: 'derived',
    };
    _sectorCache = { data, fetchedAt: Date.now() };
    return data;
  }

  /** List all available analysis charts from GET /analyses. */
  async listCharts(): Promise<SoSoChartMeta[]> {
    const API_KEY = process.env.SOSOVALUE_API_KEY;
    if (!API_KEY) { console.warn('[SoSoValueClient] listCharts: no API key'); return []; }

    try {
      const res = await axios.get(`${BASE_URL}/analyses`, { headers: _authHeaders(API_KEY), timeout: 8000 });
      const data: unknown[] = res.data?.data ?? [];
      return data.map((item: any) => ({
        name: String(item.chart_name ?? item.name ?? ''),
        fields: Array.isArray(item.fields) ? item.fields.map((f: any) => String(f.name ?? f)) : [],
      })).filter(c => c.name);
    } catch (err: any) {
      console.error('[SoSoValueClient] listCharts error:', err.message);
      return [];
    }
  }

  /** Fetch time-series data for any chart. GET /analyses/{chart_name}?limit=N */
  async fetchChart(chartName: string, limit = 30): Promise<Record<string, unknown>[] | null> {
    const API_KEY = process.env.SOSOVALUE_API_KEY;
    if (!API_KEY) return null;

    try {
      const res = await axios.get(`${BASE_URL}/analyses/${encodeURIComponent(chartName)}`, {
        headers: _authHeaders(API_KEY),
        params: { limit },
        timeout: 8000,
      });
      const data = res.data?.data;
      if (!Array.isArray(data)) { console.warn('[SoSoValueClient] fetchChart unexpected shape for', chartName); return null; }
      return data as Record<string, unknown>[];
    } catch (err: any) {
      console.error(`[SoSoValueClient] fetchChart(${chartName}) error:`, err.message);
      return null;
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private async _discoverFearGreedChart(apiKey: string): Promise<string | null> {
    if (_fearGreedChartName) return _fearGreedChartName;

    try {
      const res = await axios.get(`${BASE_URL}/analyses`, { headers: _authHeaders(apiKey), timeout: 8000 });
      const charts: any[] = res.data?.data ?? [];

      // Debug: log all chart names
      const chartNames = charts.map((c: any) => c.chart_name ?? c.name ?? '').filter(Boolean);
      console.log(`[SoSoValueClient] DEBUG: Found ${charts.length} charts:`, chartNames.join(', '));

      const match = charts.find((c: any) => {
        const name = String(c.chart_name ?? c.name ?? '').toLowerCase();
        return name.includes('fear') || name.includes('greed') || name.includes('fgi');
      });

      if (match) {
        _fearGreedChartName = String(match.chart_name ?? match.name);
        console.log(`[SoSoValueClient] ✅ Discovered Fear & Greed chart: "${_fearGreedChartName}"`);
        return _fearGreedChartName;
      }

      console.warn(`[SoSoValueClient] No fear/greed chart found in: ${chartNames.join(', ')}`);
      return null;

    } catch (err: any) {
      console.error('[SoSoValueClient] /analyses discovery error:', err.message);
      return null;
    }
  }

  private _extractNumericValue(row: Record<string, unknown>): number | null {
    for (const [, val] of Object.entries(row)) {
      const n = Number(val);
      if (isNaN(n) || n > 9.46e11) continue;
      if (n >= 0 && n <= 100) return n;
    }
    return null;
  }

  private async _fetchFallback(): Promise<SoSoValueData | null> {
    try {
      const res = await axios.get('https://api.alternative.me/fng/?limit=1', { timeout: 5000 });
      const entry = res.data?.data?.[0];
      if (!entry) return null;

      const fearGreedIndex = Number(entry.value);
      if (isNaN(fearGreedIndex)) return null;

      const fearGreedLabel = String(entry.value_classification ?? _labelFromIndex(fearGreedIndex));
      const result: SoSoValueData = { sectorIndex: fearGreedIndex, fearGreedIndex, fearGreedLabel, source: 'alternative.me' };
      console.log(`[SoSoValueClient] Fallback: Fear & Greed ${fearGreedIndex} (${fearGreedLabel}) — source: alternative.me`);
      return result;

    } catch (err) {
      console.error('[SoSoValueClient] Fallback fetch error:', err);
      return null;
    }
  }
}
