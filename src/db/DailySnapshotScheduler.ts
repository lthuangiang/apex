/**
 * DailySnapshotScheduler — Captures balance snapshots for all tenant accounts at 0h UTC daily.
 *
 * Runs as a background timer (checks every minute), fires once at 0h UTC.
 * Captures equity from every running bot's adapter.
 *
 * Usage:
 *   import { startDailySnapshotScheduler, stopDailySnapshotScheduler } from '../db/DailySnapshotScheduler.js';
 *   startDailySnapshotScheduler(tenantRegistry);
 */

import type { TenantRegistry } from '../bot/TenantRegistry.js';
import { captureBalance } from './ReportingCollector.js';

let _timer: ReturnType<typeof setInterval> | null = null;
let _lastSnapshotDate = '';

/**
 * Start the daily snapshot scheduler. Checks every 60s if it's a new UTC day.
 */
export function startDailySnapshotScheduler(tenantRegistry: TenantRegistry): void {
  if (_timer) return;

  // Seed with today so we don't fire immediately on startup
  _lastSnapshotDate = _todayUtc();

  _timer = setInterval(async () => {
    const today = _todayUtc();
    const nowHour = new Date().getUTCHours();
    const nowMinute = new Date().getUTCMinutes();

    // Fire at 0h UTC (first minute of the new day)
    if (today !== _lastSnapshotDate && nowHour === 0 && nowMinute < 2) {
      _lastSnapshotDate = today;
      await _captureAllBalances(tenantRegistry);
    }
  }, 60_000);

  console.log('[DailySnapshotScheduler] Started — captures all account balances at 0h UTC');
}

/**
 * Stop the daily snapshot scheduler.
 */
export function stopDailySnapshotScheduler(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    console.log('[DailySnapshotScheduler] Stopped');
  }
}

/**
 * Force a snapshot now (useful for testing or manual trigger).
 */
export async function forceSnapshotNow(tenantRegistry: TenantRegistry): Promise<number> {
  return _captureAllBalances(tenantRegistry);
}

// ─── Private ──────────────────────────────────────────────────────────────────

async function _captureAllBalances(tenantRegistry: TenantRegistry): Promise<number> {
  let captured = 0;
  const allTenants = tenantRegistry.getAllTenants();

  for (const tenant of allTenants) {
    const bots = tenant.botManager.getAllBots();
    for (const bot of bots) {
      try {
        // Get adapter from bot (duck-typed: all bot types expose adapter via private field)
        const adapter = (bot as any).adapter as { get_balance: () => Promise<number> } | undefined;
        if (!adapter?.get_balance) continue;

        const equity = await adapter.get_balance();
        const exchange = (bot as any).config?.exchange ?? 'unknown';

        captureBalance({
          exchange,
          equity,
          trigger: 'daily',
          walletAddress: (bot as any).state?.walletAddress || tenant.walletAddress,
        });
        captured++;
      } catch (err) {
        console.warn(`[DailySnapshotScheduler] Failed to capture balance for bot ${bot.id}:`, err);
      }
    }
  }

  if (captured > 0) {
    console.log(`[DailySnapshotScheduler] Captured ${captured} balance snapshot(s) at ${_todayUtc()} 0h UTC`);
  }

  return captured;
}

function _todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}
