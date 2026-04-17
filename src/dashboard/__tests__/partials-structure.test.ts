import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import request from 'supertest';
import { TradeLogger } from '../../ai/TradeLogger.js';
import { DashboardServer } from '../server.js';

const VIEWS_DIR = path.resolve('src/dashboard/views');

const EXPECTED_PARTIALS = [
  'layout.ejs',
  'partials/header.ejs',
  'partials/tab-nav.ejs',
  'partials/overview/tier-week-position.ejs',
  'partials/overview/ctrl-panel.ejs',
  'partials/overview/cfg-modal.ejs',
  'partials/overview/stats-charts.ejs',
  'partials/overview/realtime-log.ejs',
  'partials/overview/tables.ejs',
  'partials/analytics/summary-cards.ejs',
  'partials/analytics/mode-signal.ejs',
  'partials/analytics/charts.ejs',
  'partials/analytics/best-worst-holding.ejs',
];

function makeTempPath(ext: string): string {
  return path.join(os.tmpdir(), `partials-test-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
}

describe('Dashboard Partials — Smoke Tests', () => {
  it('EJS is registered as the view engine', () => {
    const logPath = makeTempPath('json');
    const logger = new TradeLogger('json', logPath);
    const server = new DashboardServer(logger, 0);
    expect(server.app.get('view engine')).toBe('ejs');
    try { fs.unlinkSync(logPath); } catch { /* ignore */ }
  });

  it('views directory is set correctly', () => {
    const logPath = makeTempPath('json');
    const logger = new TradeLogger('json', logPath);
    const server = new DashboardServer(logger, 0);
    const registeredViews = server.app.get('views');
    // Should end with 'views' (works for both src and dist paths)
    expect(registeredViews).toMatch(/views$/);
    try { fs.unlinkSync(logPath); } catch { /* ignore */ }
  });

  it('all 13 partial files + layout.ejs exist on disk', () => {
    for (const partial of EXPECTED_PARTIALS) {
      const fullPath = path.join(VIEWS_DIR, partial);
      expect(fs.existsSync(fullPath), `Missing: ${partial}`).toBe(true);
    }
  });

  it('GET /css/main.css returns 200', async () => {
    const logPath = makeTempPath('json');
    const logger = new TradeLogger('json', logPath);
    const server = new DashboardServer(logger, 0);
    const res = await request(server.app).get('/css/main.css');
    expect(res.status).toBe(200);
    try { fs.unlinkSync(logPath); } catch { /* ignore */ }
  });

  it('GET /js/dashboard.js returns 200', async () => {
    const logPath = makeTempPath('json');
    const logger = new TradeLogger('json', logPath);
    const server = new DashboardServer(logger, 0);
    const res = await request(server.app).get('/js/dashboard.js');
    expect(res.status).toBe(200);
    try { fs.unlinkSync(logPath); } catch { /* ignore */ }
  });

  it('no partial files contain inline <style> tags', () => {
    for (const partial of EXPECTED_PARTIALS) {
      const fullPath = path.join(VIEWS_DIR, partial);
      if (!fs.existsSync(fullPath)) continue;
      const content = fs.readFileSync(fullPath, 'utf-8');
      expect(content, `${partial} should not contain <style> tags`).not.toMatch(/<style[\s>]/i);
    }
  });

  it('no partial files contain inline <script> blocks with application logic', () => {
    for (const partial of EXPECTED_PARTIALS) {
      const fullPath = path.join(VIEWS_DIR, partial);
      if (!fs.existsSync(fullPath)) continue;
      const content = fs.readFileSync(fullPath, 'utf-8');
      // Allow <script src="..."> but not inline <script> blocks with code
      const inlineScript = /<script(?![^>]*\bsrc\b)[^>]*>[\s\S]*?<\/script>/i;
      expect(content, `${partial} should not contain inline <script> blocks`).not.toMatch(inlineScript);
    }
  });
});
