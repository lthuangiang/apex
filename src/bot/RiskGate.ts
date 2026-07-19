/**
 * RiskGate — Portfolio-Level Risk Enforcement
 *
 * Evaluates every AgentDecision before it reaches the execution layer.
 * Enforces:
 *   - Max session loss → risk_halt
 *   - ExposureCap → block new entries
 *   - Consecutive loss cooldown (3 losses → 10 min cooldown)
 *   - Never blocks exit orders
 *
 * Requirements: 7.1–7.8
 */

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type RiskGateStatus = 'OPEN' | 'HALTED' | 'COOLDOWN';

export interface RiskGateState {
  status: RiskGateStatus;
  reason: string;
  haltedAt: string | null;
  cooldownUntil: string | null;
  consecutiveLosses: number;
}

export interface RiskGateConfig {
  maxLossUsd: number;              // session PnL threshold (e.g. -5)
  exposureCapUsd: number;          // max open notional
  consecutiveLossHalt: number;     // number of consecutive losses to trigger cooldown (default: 3)
  lossCooldownMins: number;        // minutes to wait after consecutive losses (default: 10)
}

export interface RiskCheckInput {
  sessionPnl: number;
  totalOpenExposureUsd: number;
  isExitOrder: boolean;            // exit orders are never blocked
}

export interface RiskCheckResult {
  allowed: boolean;
  status: RiskGateStatus;
  reason: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// RISK GATE
// ═══════════════════════════════════════════════════════════════════════════════

export class RiskGate {
  private cfg: RiskGateConfig;
  private _status: RiskGateStatus = 'OPEN';
  private _reason = 'No risk conditions triggered';
  private _haltedAt: string | null = null;
  private _cooldownUntil: string | null = null;
  private _consecutiveLosses = 0;

  // Callback for Telegram notification on halt
  private _onHalt: ((reason: string, pnl: number) => void) | null = null;

  constructor(cfg: RiskGateConfig) {
    this.cfg = cfg;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Evaluate whether a new entry is allowed.
   * Exit orders are NEVER blocked (Req 7.6).
   *
   * Requirements: 7.1–7.7
   */
  check(input: RiskCheckInput): RiskCheckResult {
    // Req 7.6: Never block exits
    if (input.isExitOrder) {
      return { allowed: true, status: this._status, reason: 'Exit order — always allowed' };
    }

    // Check cooldown expiry
    this._checkCooldownExpiry();

    // Req 7.2: Session PnL below MAX_LOSS → halt
    if (input.sessionPnl <= -Math.abs(this.cfg.maxLossUsd)) {
      this._halt(`Session loss $${input.sessionPnl.toFixed(2)} exceeds MAX_LOSS $${this.cfg.maxLossUsd}`);
      return { allowed: false, status: 'HALTED', reason: this._reason };
    }

    // Req 7.3: Exposure cap exceeded → block
    if (input.totalOpenExposureUsd >= this.cfg.exposureCapUsd) {
      const reason = `Exposure $${input.totalOpenExposureUsd.toFixed(0)} >= cap $${this.cfg.exposureCapUsd}`;
      return { allowed: false, status: this._status, reason };
    }

    // Req 7.3: Wait until exposure falls below 90% to re-allow after exceeding
    if (this._status === 'HALTED' && input.totalOpenExposureUsd >= this.cfg.exposureCapUsd * 0.9) {
      return { allowed: false, status: 'HALTED', reason: this._reason };
    }

    // Cooldown active
    if (this._status === 'COOLDOWN') {
      return { allowed: false, status: 'COOLDOWN', reason: this._reason };
    }

    // Halted
    if (this._status === 'HALTED') {
      return { allowed: false, status: 'HALTED', reason: this._reason };
    }

    // All clear
    return { allowed: true, status: 'OPEN', reason: 'No risk conditions triggered' };
  }

  /**
   * Record a trade result to track consecutive losses.
   * Req 7.4: 3 consecutive losses → 10 min cooldown.
   */
  recordTradeResult(won: boolean): void {
    if (won) {
      this._consecutiveLosses = 0;
      // If we were in cooldown, winning resets it
      if (this._status === 'COOLDOWN') {
        this._status = 'OPEN';
        this._reason = 'Cooldown cleared by winning trade';
        this._cooldownUntil = null;
      }
    } else {
      this._consecutiveLosses++;
      if (this._consecutiveLosses >= this.cfg.consecutiveLossHalt) {
        this._enterCooldown();
      }
    }
  }

  /**
   * Get current risk gate state (Req 7.8).
   */
  getRiskStatus(): RiskGateState {
    this._checkCooldownExpiry();
    return {
      status: this._status,
      reason: this._reason,
      haltedAt: this._haltedAt,
      cooldownUntil: this._cooldownUntil,
      consecutiveLosses: this._consecutiveLosses,
    };
  }

  /**
   * Register Telegram notification callback for halt events (Req 7.7).
   */
  onHalt(cb: (reason: string, pnl: number) => void): void {
    this._onHalt = cb;
  }

  /**
   * Manually reset the gate (e.g. after daily budget reset).
   */
  reset(): void {
    this._status = 'OPEN';
    this._reason = 'Manual reset';
    this._haltedAt = null;
    this._cooldownUntil = null;
    this._consecutiveLosses = 0;
  }

  /**
   * Update config at runtime.
   */
  updateConfig(patch: Partial<RiskGateConfig>): void {
    Object.assign(this.cfg, patch);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE
  // ═══════════════════════════════════════════════════════════════════════════

  private _halt(reason: string): void {
    if (this._status === 'HALTED') return; // already halted
    this._status = 'HALTED';
    this._reason = reason;
    this._haltedAt = new Date().toISOString();
    console.warn(`[RiskGate] HALTED: ${reason}`);
    // Req 7.7: Telegram notification
    if (this._onHalt) {
      this._onHalt(reason, 0); // PnL will be logged by caller
    }
  }

  private _enterCooldown(): void {
    const until = new Date(Date.now() + this.cfg.lossCooldownMins * 60 * 1000);
    this._status = 'COOLDOWN';
    this._reason = `${this._consecutiveLosses} consecutive losses — cooldown until ${until.toISOString()}`;
    this._cooldownUntil = until.toISOString();
    console.warn(`[RiskGate] COOLDOWN: ${this._reason}`);
  }

  private _checkCooldownExpiry(): void {
    if (this._status !== 'COOLDOWN' || !this._cooldownUntil) return;
    if (Date.now() >= new Date(this._cooldownUntil).getTime()) {
      this._status = 'OPEN';
      this._reason = 'Cooldown expired — gate re-opened';
      this._cooldownUntil = null;
      this._consecutiveLosses = 0;
      console.log('[RiskGate] Cooldown expired, gate OPEN');
    }
  }
}
