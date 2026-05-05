/**
 * DailyResetScheduler
 *
 * Resets a bot's daily budget at a configured UTC hour (default: 0 = midnight UTC = 7h Vietnam).
 * Supports two stop conditions — whichever is hit first stops the bot for the day:
 *   1. Max loss (USD) — bot stops when session PnL ≤ -maxLossUsd
 *   2. Volume target (USD) — bot stops when session volume ≥ targetVolumeUsd
 *
 * At the configured reset hour, the scheduler:
 *   1. Stops the bot (if still running)
 *   2. Resets both the max-loss flag and the volume-target flag
 *   3. Re-applies the daily budget (maxLossUsd + targetVolumeUsd)
 *   4. Auto-starts the bot with a fresh session
 *   5. Fires the onReset callback (e.g. Telegram notification)
 *
 * Usage:
 *   const scheduler = new DailyResetScheduler(botInstance, {
 *     resetHourUTC: 0,
 *     maxLossUsd: 5,
 *     targetVolumeUsd: 5000,
 *   });
 *   scheduler.start();
 *   // ...
 *   scheduler.stop();
 */

export interface DailyResetConfig {
  /** UTC hour to trigger the daily reset (0–23). Default: 0 (midnight UTC = 7h Vietnam) */
  resetHourUTC: number;
  /** Max loss budget for the day (USD). Reapplied on each reset. */
  maxLossUsd: number;
  /**
   * Daily volume target (USD). Bot stops when session volume reaches this value.
   * 0 = disabled (no volume target).
   */
  targetVolumeUsd: number;
}

export interface DailyResetTarget {
  readonly id: string;
  start(): Promise<boolean>;
  stop(): Promise<void>;
  clearSessionState(): Promise<void>;
  getSessionManager(): {
    resetMaxLoss(): void;
    resetVolumeTarget(): void;
    setMaxLoss(amount: number): void;
    setTargetVolume(usd: number): void;
    getState(): { isRunning: boolean; currentPnL: number; currentVolumeUsd: number };
  };
  getWatcher(): { resetSession(): void };
  readonly state: { botStatus: 'RUNNING' | 'STOPPED' };
}

export class DailyResetScheduler {
  private bot: DailyResetTarget;
  private config: DailyResetConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastResetDate: string = '';
  private onReset?: (botId: string, reason: 'scheduled') => void;

  constructor(
    bot: DailyResetTarget,
    config: DailyResetConfig,
    onReset?: (botId: string, reason: 'scheduled') => void,
  ) {
    this.bot = bot;
    this.config = config;
    this.onReset = onReset;
  }

  /** Start the scheduler — checks every minute */
  start(): void {
    if (this.timer) return;

    // Seed lastResetDate so we don't fire immediately on startup if it's already past reset hour
    this.lastResetDate = this._todayResetKey();

    this.timer = setInterval(() => {
      this._tick().catch(err =>
        console.error(`[DailyResetScheduler:${this.bot.id}] tick error:`, err),
      );
    }, 60_000); // check every minute

    const parts: string[] = [`maxLoss=$${this.config.maxLossUsd}`];
    if (this.config.targetVolumeUsd > 0) {
      parts.push(`targetVolume=$${this.config.targetVolumeUsd.toLocaleString()}`);
    }

    console.log(
      `[DailyResetScheduler:${this.bot.id}] Started — resets daily at ${this.config.resetHourUTC}:00 UTC (${this._utcToVietnam(this.config.resetHourUTC)}:00 Vietnam) | ${parts.join(', ')}`,
    );
  }

  /** Stop the scheduler */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log(`[DailyResetScheduler:${this.bot.id}] Stopped`);
    }
  }

  /** Returns true if the scheduler is currently active */
  isRunning(): boolean {
    return this.timer !== null;
  }

  /** Force a manual reset (useful for testing or manual trigger from dashboard) */
  async forceReset(): Promise<void> {
    console.log(`[DailyResetScheduler:${this.bot.id}] Manual reset triggered`);
    await this._doReset();
    this.lastResetDate = this._todayResetKey();
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async _tick(): Promise<void> {
    const now = new Date();
    const currentHourUTC = now.getUTCHours();
    const currentMinuteUTC = now.getUTCMinutes();
    const todayKey = this._todayResetKey();

    // Fire once per day at the configured UTC hour (within the first minute of that hour)
    if (
      currentHourUTC === this.config.resetHourUTC &&
      currentMinuteUTC === 0 &&
      todayKey !== this.lastResetDate
    ) {
      this.lastResetDate = todayKey;
      await this._doReset();
    }
  }

  private async _doReset(): Promise<void> {
    const sm = this.bot.getSessionManager();
    const wasRunning = this.bot.state.botStatus === 'RUNNING';

    const parts: string[] = [`maxLoss=$${this.config.maxLossUsd}`];
    if (this.config.targetVolumeUsd > 0) {
      parts.push(`targetVolume=$${this.config.targetVolumeUsd.toLocaleString()}`);
    }
    console.log(
      `\n🔄 [DailyResetScheduler:${this.bot.id}] Daily reset — ${parts.join(', ')}`,
    );

    // 1. Stop bot if running (to cleanly reset session)
    if (wasRunning) {
      await this.bot.stop();
    }

    // 2. Reset both stop-condition flags
    sm.resetMaxLoss();
    sm.resetVolumeTarget();

    // 3. Re-apply daily budget limits
    sm.setMaxLoss(this.config.maxLossUsd);
    sm.setTargetVolume(this.config.targetVolumeUsd);

    // 4. Clear persisted session stats so the new session starts fresh.
    //    Without this, loadState() in bot.start() would restore the old
    //    sessionVolume / sessionPnl / sessionStartBalance from disk, causing
    //    the volume-target check to fire immediately and PnL to be wrong.
    await this.bot.clearSessionState();

    // 5. Auto-restart the bot
    const started = await this.bot.start();
    if (started) {
      console.log(`✅ [DailyResetScheduler:${this.bot.id}] Bot auto-restarted — ${parts.join(', ')}`);
    } else {
      console.warn(`⚠️ [DailyResetScheduler:${this.bot.id}] Bot failed to restart after daily reset`);
    }

    // 6. Notify callback (e.g. send Telegram message)
    this.onReset?.(this.bot.id, 'scheduled');
  }

  /** Returns a date string key for "today at reset hour" in UTC */
  private _todayResetKey(): string {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}@${this.config.resetHourUTC}`;
  }

  /** Convert UTC hour to Vietnam time (UTC+7) */
  private _utcToVietnam(utcHour: number): number {
    return (utcHour + 7) % 24;
  }
}
