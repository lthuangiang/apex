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

// ── Internal cache ────────────────────────────────────────────────────────────

let _fearGreedChartName: string | null = null;

let _etfCache: { data: EtfFlowData; fetchedAt: number } | null = null;
const ETF_CACHE_TTL = 4 * 60 * 60 * 1000;

let _macroCache: { data: MacroRisk; fetchedAt: number } | null = null;
const MACRO_CACHE_TTL = 60 * 60 * 1000; // 1 hour

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
