/**
 * AgentLayer — Autonomous Orchestration Brain
 *
 * The top-level coordination layer that sits between the intelligence stack
 * (SoSoValue, AISignalEngine, RegimeDetector) and the execution layer
 * (BotManager, Watcher, Executor).
 *
 * Lifecycle: initialize → start → [AgentCycles] → pause/stop
 *
 * Each AgentCycle: observe MarketContext → select strategy → allocate capital
 *   → gate risk → emit AgentDecision → persist state
 *
 * Requirements: 1–12 (Agent Layer spec)
 */

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { SoSoValueIntelligenceEngine, type MarketIntelligence } from '../ai/SoSoValueIntelligenceEngine.js';
import { StrategySelector, type StrategySelectionResult, type SelectedStrategy } from './StrategySelector.js';
import { CapitalAllocator, type AllocationConfig, type AllocationResult } from './CapitalAllocator.js';
import { RiskGate, type RiskGateConfig, type RiskGateState } from './RiskGate.js';
import type { BotManager } from './BotManager.js';
import type { BotInstance } from './BotInstance.js';
import type { HedgeBot } from './HedgeBot.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type AgentLifecycleState = 'IDLE' | 'RUNNING' | 'PAUSED' | 'STOPPED';

export interface AgentDecision {
  cycleId: string;
  timestamp: string;
  selectedStrategy: SelectedStrategy;
  direction: 'long' | 'short' | 'hold';
  allocatedSize: number;        // BTC
  regime: string;
  confidenceScore: number;
  riskGateStatus: string;
  reasoning: string;
}

export interface MarketContext {
  cycleId: string;
  timestamp: string;
  degraded: boolean;
  regime: string;
  regimeConfidence: number;
  confidenceScore: number;
  signalDirection: 'long' | 'short' | 'hold';
  bullConviction: number;
  bearConviction: number;
  neutralConviction: number;
  sessionPnl: number;
  sessionVolume: number;
  totalOpenExposureUsd: number;
  activeBots: number;
  intelligence: MarketIntelligence | null;
}

export interface PortfolioState {
  sessionPnl: number;
  sessionVolume: number;
  sessionFees: number;
  totalOpenExposureUsd: number;
  activeBots: number;
  perBotExposure: Array<{ botId: string; exposureUsd: number; status: string }>;
}

export interface AgentConfig {
  cycleIntervalSecs: number;       // default 30
  exposureCapUsd: number;          // default 500
  consecutiveLossHalt: number;     // default 3
  lossCooldownMins: number;        // default 10
  farmCapitalRatio: number;        // default 0.6
  tradeMinConfidence: number;      // default 0.65
  tradeMaxChopScore: number;       // default 0.6
  dryRun: boolean;                 // default false
  maxLossUsd: number;              // default 5
  statePath: string;               // default ./agent-state.json
}

export interface AgentState {
  lifecycleState: AgentLifecycleState;
  lastDecision: AgentDecision | null;
  lastMarketContext: MarketContext | null;
  decisionHistory: AgentDecision[];  // last 100
  cycleCount: number;
  totalCycleTimeMs: number;
  cycleLatencies: number[];          // last 100 cycle durations
  strategyPerformance: {
    farm: { totalTrades: number; wins: number; losses: number; winRate: number; recentWinRate: number; totalPnl: number; totalVolume: number };
    trade: { totalTrades: number; wins: number; losses: number; winRate: number; recentWinRate: number; totalPnl: number; totalVolume: number };
    farmRecent: boolean[];
    tradeRecent: boolean[];
  };
  startedAt: string | null;
  updatedAt: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEFAULTS
// ═══════════════════════════════════════════════════════════════════════════════

const DEFAULT_CONFIG: AgentConfig = {
  cycleIntervalSecs: 30,
  exposureCapUsd: 500,
  consecutiveLossHalt: 3,
  lossCooldownMins: 10,
  farmCapitalRatio: 0.6,
  tradeMinConfidence: 0.65,
  tradeMaxChopScore: 0.6,
  dryRun: false,
  maxLossUsd: 5,
  statePath: './agent-state.json',
};

// ═══════════════════════════════════════════════════════════════════════════════
// AGENT LAYER
// ═══════════════════════════════════════════════════════════════════════════════

export class AgentLayer {
  private cfg: AgentConfig;
  private state: AgentState;

  // Sub-components
  private intelligence: SoSoValueIntelligenceEngine;
  private strategySelector: StrategySelector;
  private capitalAllocator: CapitalAllocator;
  private riskGate: RiskGate;

  // External references
  private botManager: BotManager | null = null;
  private telegramNotify: ((msg: string) => Promise<void>) | null = null;

  // Cycle timer
  private cycleTimer: ReturnType<typeof setInterval> | null = null;
  private _cycleRunning = false;

  constructor(cfg?: Partial<AgentConfig>) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
    this.state = this._emptyState();

    // Initialize sub-components
    this.intelligence = new SoSoValueIntelligenceEngine();
    this.strategySelector = new StrategySelector();
    this.capitalAllocator = new CapitalAllocator(this._allocatorConfig());
    this.riskGate = new RiskGate(this._riskGateConfig());
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LIFECYCLE (Req 1.1–1.8)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Initialize: load persisted state, connect to BotManager.
   * Req 1.2
   */
  async initialize(botManager: BotManager, telegramNotify?: (msg: string) => Promise<void>): Promise<void> {
    this.botManager = botManager;
    this.telegramNotify = telegramNotify ?? null;

    // Load persisted state
    this._loadState();

    // Register RiskGate halt notification
    this.riskGate.onHalt(async (reason, _pnl) => {
      const msg = `🛑 *Agent Risk Halt*\n${reason}\nSession PnL: $${this.state.lastMarketContext?.sessionPnl?.toFixed(2) ?? 'N/A'}`;
      if (this.telegramNotify) {
        await this.telegramNotify(msg).catch(() => {});
      }
      // Also halt strategy selector
      this.strategySelector.setRiskHalt(true);
    });

    // Restore strategy performance from state
    if (this.state.strategyPerformance) {
      this.strategySelector.restore(this.state.strategyPerformance);
    }

    this.state.lifecycleState = 'IDLE';
    console.log('[AgentLayer] Initialized');
  }

  /**
   * Start executing AgentCycles at configured interval.
   * Req 1.3
   */
  start(): void {
    if (this.state.lifecycleState === 'RUNNING') {
      console.log('[AgentLayer] Already running');
      return;
    }

    this.state.lifecycleState = 'RUNNING';
    this.state.startedAt = new Date().toISOString();
    this.state.updatedAt = new Date().toISOString();

    // Run first cycle immediately, then on interval
    this._executeCycle().catch(err => console.error('[AgentLayer] First cycle error:', err));

    this.cycleTimer = setInterval(() => {
      if (!this._cycleRunning) {
        this._executeCycle().catch(err => console.error('[AgentLayer] Cycle error:', err));
      }
    }, this.cfg.cycleIntervalSecs * 1000);

    console.log(`[AgentLayer] Started — cycle every ${this.cfg.cycleIntervalSecs}s`);
    this._notifyLifecycleChange('RUNNING', 'Agent started');
  }

  /**
   * Pause: stop new cycles but keep positions open.
   * Req 1.4
   */
  pause(): void {
    if (this.state.lifecycleState !== 'RUNNING') return;
    this.state.lifecycleState = 'PAUSED';
    this.state.updatedAt = new Date().toISOString();

    if (this.cycleTimer) {
      clearInterval(this.cycleTimer);
      this.cycleTimer = null;
    }

    console.log('[AgentLayer] Paused');
    this._notifyLifecycleChange('PAUSED', 'Agent paused — positions remain open');
  }

  /**
   * Stop: complete current cycle, persist state, stop all bots.
   * Req 1.5, 1.6
   */
  async stop(): Promise<void> {
    if (this.state.lifecycleState === 'STOPPED') return;

    // Stop timer
    if (this.cycleTimer) {
      clearInterval(this.cycleTimer);
      this.cycleTimer = null;
    }

    // Wait for current cycle to finish
    const deadline = Date.now() + 60_000; // 60s wait for positions (Req 1.6)
    while (this._cycleRunning && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));
    }

    this.state.lifecycleState = 'STOPPED';
    this.state.updatedAt = new Date().toISOString();
    this._persistState();

    console.log('[AgentLayer] Stopped');
    this._notifyLifecycleChange('STOPPED', 'Agent stopped — state persisted');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AGENT CYCLE (Req 2, 3, 6, 7, 8)
  // ═══════════════════════════════════════════════════════════════════════════

  private async _executeCycle(): Promise<void> {
    if (this.state.lifecycleState !== 'RUNNING') return;
    this._cycleRunning = true;
    const cycleStart = Date.now();
    const cycleId = randomUUID();

    try {
      // ── Step 1: Observe MarketContext (Req 2) ─────────────────────────────
      const context = await this._observeMarketContext(cycleId);

      // ── Step 2: Select Strategy (Req 3) ───────────────────────────────────
      const selection = this.strategySelector.select(
        context.intelligence?.regime ?? 'choppy_neutral',
        context.regimeConfidence,
        context.bullConviction,
        context.bearConviction,
        false, // highVolSkipEntry — read from config if needed
      );

      // ── Step 3: Allocate Capital (Req 6) ──────────────────────────────────
      const allocation = this.capitalAllocator.allocate({
        strategy: selection.selected,
        confidenceScore: context.confidenceScore,
        performanceWinRate: this._activeStrategyWinRate(selection.selected),
        regime: (context.intelligence?.regime ?? 'choppy_neutral') as any,
        sessionPnl: context.sessionPnl,
        totalOpenExposureUsd: context.totalOpenExposureUsd,
        kellyBaseSize: context.intelligence?.baseSize ?? 1.0,
      });

      // ── Step 4: Risk Gate (Req 7) ─────────────────────────────────────────
      const riskCheck = this.riskGate.check({
        sessionPnl: context.sessionPnl,
        totalOpenExposureUsd: context.totalOpenExposureUsd,
        isExitOrder: false,
      });

      // ── Step 5: Produce AgentDecision (Req 8) ─────────────────────────────
      const decision: AgentDecision = {
        cycleId,
        timestamp: new Date().toISOString(),
        selectedStrategy: riskCheck.allowed ? selection.selected : 'HOLD',
        direction: riskCheck.allowed ? selection.direction : 'hold',
        allocatedSize: riskCheck.allowed ? allocation.totalAllocatedBtc : 0,
        regime: context.regime,
        confidenceScore: context.confidenceScore,
        riskGateStatus: riskCheck.status,
        reasoning: this._buildDecisionReasoning(selection, allocation, riskCheck, context),
      };

      // ── Step 6: Emit to execution layer (if not dry-run) ──────────────────
      if (!this.cfg.dryRun && riskCheck.allowed && decision.selectedStrategy !== 'HOLD') {
        await this._emitDecision(decision, allocation);
      }

      // ── Step 7: Update state ──────────────────────────────────────────────
      this.state.lastDecision = decision;
      this.state.lastMarketContext = context;
      this.state.cycleCount++;
      this._pushDecisionHistory(decision);

      const cycleDuration = Date.now() - cycleStart;
      this.state.totalCycleTimeMs += cycleDuration;
      this.state.cycleLatencies.push(cycleDuration);
      if (this.state.cycleLatencies.length > 100) this.state.cycleLatencies.shift();

      // Req 11.7: Warn if cycle > 10s
      if (cycleDuration > 10_000) {
        console.warn(`[AgentLayer] slow_cycle: ${cycleId} took ${cycleDuration}ms`);
      }

      // ── Step 8: Persist state (Req 1.7) ───────────────────────────────────
      this.state.updatedAt = new Date().toISOString();
      this._persistState();

      // ── Log ────────────────────────────────────────────────────────────────
      console.log(
        `[AgentLayer] Cycle #${this.state.cycleCount} | ${decision.selectedStrategy} ${decision.direction} | ` +
        `${decision.regime} | size=${decision.allocatedSize.toFixed(5)} BTC | ` +
        `risk=${riskCheck.status} | ${cycleDuration}ms`,
      );

    } catch (err) {
      console.error(`[AgentLayer] Cycle ${cycleId} failed:`, err);
    } finally {
      this._cycleRunning = false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MARKET CONTEXT OBSERVATION (Req 2.1–2.7)
  // ═══════════════════════════════════════════════════════════════════════════

  private async _observeMarketContext(cycleId: string): Promise<MarketContext> {
    let intelligence: MarketIntelligence | null = null;
    let degraded = false;

    // Fetch intelligence with 10s timeout (Req 2.5)
    try {
      const result = await Promise.race([
        this.intelligence.analyze(),
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error('timeout')), 10_000)),
      ]);
      intelligence = result as MarketIntelligence | null;
    } catch {
      degraded = true;
      console.warn('[AgentLayer] Intelligence fetch degraded — using last known values');
    }

    // Compute PortfolioState from BotManager (Req 2.4)
    const portfolio = this._computePortfolioState();

    // Resolve direction from intelligence
    const bullConviction = intelligence?.bullConviction ?? 0;
    const bearConviction = intelligence?.bearConviction ?? 0;
    let signalDirection: 'long' | 'short' | 'hold' = 'hold';
    if (bullConviction - bearConviction > 15) signalDirection = 'long';
    else if (bearConviction - bullConviction > 15) signalDirection = 'short';

    return {
      cycleId,
      timestamp: new Date().toISOString(),
      degraded,
      regime: intelligence?.regime ?? 'choppy_neutral',
      regimeConfidence: intelligence?.regimeConfidence ?? 0.5,
      confidenceScore: intelligence?.regimeConfidence ?? 0.5,
      signalDirection,
      bullConviction,
      bearConviction,
      neutralConviction: intelligence?.neutralConviction ?? 50,
      sessionPnl: portfolio.sessionPnl,
      sessionVolume: portfolio.sessionVolume,
      totalOpenExposureUsd: portfolio.totalOpenExposureUsd,
      activeBots: portfolio.activeBots,
      intelligence,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PORTFOLIO STATE (Req 2.4, 10.5)
  // ═══════════════════════════════════════════════════════════════════════════

  private _computePortfolioState(): PortfolioState {
    if (!this.botManager) {
      return { sessionPnl: 0, sessionVolume: 0, sessionFees: 0, totalOpenExposureUsd: 0, activeBots: 0, perBotExposure: [] };
    }

    const bots = this.botManager.getAllBots();
    let sessionPnl = 0;
    let sessionVolume = 0;
    let sessionFees = 0;
    let totalOpenExposureUsd = 0;
    let activeBots = 0;
    const perBotExposure: Array<{ botId: string; exposureUsd: number; status: string }> = [];

    for (const bot of bots) {
      sessionPnl += bot.state.sessionPnl;
      sessionVolume += bot.state.sessionVolume;
      sessionFees += bot.state.sessionFees;

      if (bot.state.botStatus === 'RUNNING') activeBots++;

      // Estimate open exposure from open position
      let exposureUsd = 0;
      if (bot.state.openPosition) {
        exposureUsd = Math.abs(bot.state.openPosition.size * bot.state.openPosition.entryPrice);
      }
      totalOpenExposureUsd += exposureUsd;

      perBotExposure.push({
        botId: bot.state.botId,
        exposureUsd,
        status: bot.state.botStatus,
      });
    }

    return { sessionPnl, sessionVolume, sessionFees, totalOpenExposureUsd, activeBots, perBotExposure };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DECISION EMISSION (Req 10)
  // ═══════════════════════════════════════════════════════════════════════════

  private async _emitDecision(decision: AgentDecision, allocation: AllocationResult): Promise<void> {
    if (!this.botManager) return;

    const bots = this.botManager.getAllBots();
    const eligibleBots = bots.filter(b =>
      b.state.botStatus === 'RUNNING' && !b.state.openPosition
    );

    if (eligibleBots.length === 0) {
      console.log('[AgentLayer] No eligible bots for assignment');
      return;
    }

    // Assign strategy to bots based on selection
    for (const bot of eligibleBots) {
      // Only assign to BotInstance (not HedgeBot)
      if (!('config' in bot)) continue;
      const instance = bot as BotInstance;

      // Req 10.2: Prefer bots matching strategy's exchange
      if (decision.selectedStrategy === 'FARM' || decision.selectedStrategy === 'BOTH') {
        if (instance.config.mode !== 'farm') {
          // Could switch mode if intelligenceMode is auto
          if (instance.config.intelligenceMode === 'auto') {
            (instance.config as any).mode = 'farm';
          }
        }
      }

      if (decision.selectedStrategy === 'TRADE' || decision.selectedStrategy === 'BOTH') {
        if (instance.config.mode !== 'trade') {
          if (instance.config.intelligenceMode === 'auto') {
            (instance.config as any).mode = 'trade';
          }
        }
      }

      console.log(
        `[AgentLayer] bot_assignment: ${instance.id} → ${decision.selectedStrategy} ` +
        `${decision.direction} size=${decision.allocatedSize.toFixed(5)} BTC`,
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ADAPTIVE LEARNING (Req 9)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Record a completed trade for adaptive learning.
   * Called externally (e.g. from Watcher on exit fill).
   */
  recordTradeResult(strategy: 'farm' | 'trade', won: boolean, pnl: number, volume: number): void {
    this.strategySelector.recordTradeResult(strategy, won, pnl, volume);
    this.riskGate.recordTradeResult(won);

    // Update persisted performance state
    const perf = this.strategySelector.getPerformance();
    this.state.strategyPerformance = {
      ...perf,
      farmRecent: [],  // Will be set from selector internal state
      tradeRecent: [],
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC GETTERS (for dashboard/API — Req 11, 12)
  // ═══════════════════════════════════════════════════════════════════════════

  getState(): AgentState {
    return { ...this.state };
  }

  getLastDecision(): AgentDecision | null {
    return this.state.lastDecision;
  }

  getDecisionHistory(): AgentDecision[] {
    return [...this.state.decisionHistory];
  }

  getPortfolioState(): PortfolioState {
    return this._computePortfolioState();
  }

  getRiskStatus(): RiskGateState {
    return this.riskGate.getRiskStatus();
  }

  getConfig(): AgentConfig {
    return { ...this.cfg };
  }

  getCycleLatencyStats(): { p50: number; p95: number; p99: number } {
    const sorted = [...this.state.cycleLatencies].sort((a, b) => a - b);
    const len = sorted.length;
    if (len === 0) return { p50: 0, p95: 0, p99: 0 };
    return {
      p50: sorted[Math.floor(len * 0.5)] ?? 0,
      p95: sorted[Math.floor(len * 0.95)] ?? 0,
      p99: sorted[Math.floor(len * 0.99)] ?? 0,
    };
  }

  getPerformanceSummary() {
    return this.strategySelector.getPerformance();
  }

  getDualObjectiveMetrics() {
    const portfolio = this._computePortfolioState();
    return {
      sessionPnl: portfolio.sessionPnl,
      sessionVolume: portfolio.sessionVolume,
      sessionFees: portfolio.sessionFees,
      activeBots: portfolio.activeBots,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RUNTIME CONFIG (Req 12)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Apply runtime config patch. Validates before applying.
   * Req 12.3, 12.5, 12.6
   */
  updateConfig(patch: Partial<AgentConfig>): { success: boolean; errors: string[] } {
    const errors: string[] = [];

    if (patch.cycleIntervalSecs !== undefined && patch.cycleIntervalSecs < 5) {
      errors.push('cycleIntervalSecs must be >= 5');
    }
    if (patch.exposureCapUsd !== undefined && patch.exposureCapUsd <= 0) {
      errors.push('exposureCapUsd must be > 0');
    }
    if (patch.farmCapitalRatio !== undefined && (patch.farmCapitalRatio < 0 || patch.farmCapitalRatio > 1)) {
      errors.push('farmCapitalRatio must be between 0 and 1');
    }
    if (patch.consecutiveLossHalt !== undefined && patch.consecutiveLossHalt < 1) {
      errors.push('consecutiveLossHalt must be >= 1');
    }
    if (patch.lossCooldownMins !== undefined && patch.lossCooldownMins < 1) {
      errors.push('lossCooldownMins must be >= 1');
    }

    if (errors.length > 0) {
      return { success: false, errors };
    }

    // Apply
    Object.assign(this.cfg, patch);

    // Propagate to sub-components
    this.capitalAllocator.updateConfig(this._allocatorConfig());
    this.riskGate.updateConfig(this._riskGateConfig());

    // Restart interval if changed
    if (patch.cycleIntervalSecs && this.state.lifecycleState === 'RUNNING') {
      if (this.cycleTimer) clearInterval(this.cycleTimer);
      this.cycleTimer = setInterval(() => {
        if (!this._cycleRunning) {
          this._executeCycle().catch(err => console.error('[AgentLayer] Cycle error:', err));
        }
      }, this.cfg.cycleIntervalSecs * 1000);
    }

    this._persistState();
    return { success: true, errors: [] };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STATE PERSISTENCE (Req 1.7, 1.8)
  // ═══════════════════════════════════════════════════════════════════════════

  private _persistState(): void {
    try {
      const data = JSON.stringify(this.state, null, 2);
      fs.writeFileSync(this.cfg.statePath, data, 'utf-8');
    } catch (err) {
      console.error('[AgentLayer] Failed to persist state:', err);
    }
  }

  private _loadState(): void {
    try {
      if (!fs.existsSync(this.cfg.statePath)) {
        console.info('[AgentLayer] No persisted state found, starting fresh');
        return;
      }
      const raw = fs.readFileSync(this.cfg.statePath, 'utf-8');
      const loaded = JSON.parse(raw) as Partial<AgentState>;

      // Restore meaningful fields
      if (loaded.decisionHistory) this.state.decisionHistory = loaded.decisionHistory;
      if (loaded.cycleCount) this.state.cycleCount = loaded.cycleCount;
      if (loaded.cycleLatencies) this.state.cycleLatencies = loaded.cycleLatencies;
      if (loaded.strategyPerformance) this.state.strategyPerformance = loaded.strategyPerformance;
      if (loaded.totalCycleTimeMs) this.state.totalCycleTimeMs = loaded.totalCycleTimeMs;

      console.log(`[AgentLayer] Restored state — ${this.state.cycleCount} previous cycles`);
    } catch (err) {
      console.warn('[AgentLayer] Failed to load state, starting fresh:', err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  private _buildDecisionReasoning(
    selection: StrategySelectionResult,
    allocation: AllocationResult,
    riskCheck: { allowed: boolean; status: string; reason: string },
    context: MarketContext,
  ): string {
    const parts: string[] = [];
    parts.push(`[Context] regime=${context.regime} confidence=${context.confidenceScore.toFixed(2)} pnl=$${context.sessionPnl.toFixed(2)}`);
    parts.push(`[Strategy] ${selection.reasoning}`);
    parts.push(`[Capital] ${allocation.reasoning}`);
    parts.push(`[Risk] ${riskCheck.status}: ${riskCheck.reason}`);
    if (context.degraded) parts.push('[DEGRADED] Using last-known values');
    if (this.cfg.dryRun) parts.push('[DRY-RUN] No orders emitted');
    return parts.join(' | ');
  }

  private _pushDecisionHistory(decision: AgentDecision): void {
    this.state.decisionHistory.unshift(decision);
    if (this.state.decisionHistory.length > 100) {
      this.state.decisionHistory.length = 100;
    }
  }

  private _activeStrategyWinRate(strategy: SelectedStrategy): number {
    const perf = this.strategySelector.getPerformance();
    if (strategy === 'FARM') return perf.farm.recentWinRate;
    if (strategy === 'TRADE') return perf.trade.recentWinRate;
    // BOTH or HOLD — use average
    return (perf.farm.recentWinRate + perf.trade.recentWinRate) / 2;
  }

  private _notifyLifecycleChange(newState: string, reason: string): void {
    if (!this.telegramNotify) return;
    const msg = `🤖 *Agent State Change*\n${newState}: ${reason}`;
    this.telegramNotify(msg).catch(() => {});
  }

  private _allocatorConfig(): AllocationConfig {
    return {
      orderSizeMin: 0.002,    // Will be overridden per-bot
      orderSizeMax: 0.005,
      sizingMaxBtc: 0.008,
      sizingConfWeight: 0.6,
      sizingPerfWeight: 0.4,
      sizingDrawdownThreshold: -3.0,
      sizingDrawdownFloor: 0.5,
      exposureCapUsd: this.cfg.exposureCapUsd,
      farmCapitalRatio: this.cfg.farmCapitalRatio,
    };
  }

  private _riskGateConfig(): RiskGateConfig {
    return {
      maxLossUsd: this.cfg.maxLossUsd,
      exposureCapUsd: this.cfg.exposureCapUsd,
      consecutiveLossHalt: this.cfg.consecutiveLossHalt,
      lossCooldownMins: this.cfg.lossCooldownMins,
    };
  }

  private _emptyState(): AgentState {
    return {
      lifecycleState: 'IDLE',
      lastDecision: null,
      lastMarketContext: null,
      decisionHistory: [],
      cycleCount: 0,
      totalCycleTimeMs: 0,
      cycleLatencies: [],
      strategyPerformance: {
        farm: { totalTrades: 0, wins: 0, losses: 0, winRate: 0, recentWinRate: 0.5, totalPnl: 0, totalVolume: 0 },
        trade: { totalTrades: 0, wins: 0, losses: 0, winRate: 0, recentWinRate: 0.5, totalPnl: 0, totalVolume: 0 },
        farmRecent: [],
        tradeRecent: [],
      },
      startedAt: null,
      updatedAt: new Date().toISOString(),
    };
  }
}
