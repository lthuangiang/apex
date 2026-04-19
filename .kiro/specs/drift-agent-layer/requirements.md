# Requirements Document

## Introduction

DRIFT is a dual-mode autonomous on-chain trading system that optimizes for two objectives simultaneously: **Volume** (for incentive farming) and **Profit** (PnL generation). Built on top of SoSoValue, DRIFT transforms market data into autonomous trading decisions and executes them across on-chain exchanges.

The core innovation is the **Dual-Mode Trading Engine**: rather than choosing between farming incentives (which often loses money on fees) or trading for profit (which generates low activity and misses incentives), DRIFT runs both strategies in a coordinated, self-adaptive framework.

The **DRIFT Agent Layer** is the autonomous orchestration brain that sits between the intelligence stack (SoSoValue data, AISignalEngine, RegimeDetector, FeedbackLoop) and the execution layer (Watcher, Executor, exchange adapters). It determines *when* to run FARM vs TRADE mode, *how much* capital to allocate between them, and *how* to manage risk exposure across multiple concurrent bots — transforming DRIFT from a configurable bot into a self-directing autonomous trading entity.

The Agent Layer integrates with the existing `BotManager`, `ConfigStore`, `AISignalEngine`, `RegimeDetector`, `FeedbackLoop`, and `AnalyticsEngine` without replacing them. It adds a coordination layer above the per-bot Watcher loop.

---

## Glossary

- **Agent**: The DRIFT Agent Layer instance — the top-level autonomous decision-making component that orchestrates all strategies and capital allocation.
- **AgentDecision**: A structured output produced by the Agent containing a strategy selection, capital allocation, risk parameters, and execution trigger for a given evaluation cycle.
- **Strategy**: A named, configurable trading approach (either `FARM` or `TRADE`) with its own entry/exit logic, mode, and performance profile.
- **FARM Mode**: The Volume Optimization Engine — always active, mean-reversion biased, short holding cycles (2–8 minutes), dynamic take-profit based on spread. Goal: maximize trading volume, capture platform incentives, minimize fee losses, maintain neutral or positive PnL.
- **TRADE Mode**: The Alpha Extraction Engine — strict signal filters, no forced trades, no time-based exits, focused on directional edge. Goal: maximize profitability, trade only high-quality opportunities.
- **StrategySelector**: The sub-component responsible for choosing which Strategy to activate based on market regime, performance history, and capital constraints.
- **CapitalAllocator**: The sub-component responsible for computing how much capital (position size in USD or BTC) to assign to each active Strategy.
- **RiskGate**: The sub-component that evaluates portfolio-level risk constraints before any trade is authorized — including drawdown limits, exposure caps, and session loss limits.
- **AgentCycle**: One full evaluation loop of the Agent: observe → decide → allocate → gate → emit.
- **MarketContext**: The aggregated snapshot of market data, regime, signal, and portfolio state consumed by the Agent at the start of each AgentCycle.
- **PortfolioState**: The real-time view of all open positions, session PnL, total exposure, and per-strategy performance across all active bots.
- **ExposureCap**: The maximum total USD notional the Agent will allow to be open simultaneously across all bots.
- **DrawdownGuard**: A risk rule that reduces position sizing or halts new entries when session drawdown exceeds a configured threshold.
- **ConfidenceScore**: A calibrated 0–1 probability estimate from the AISignalEngine representing the Agent's conviction in a directional trade.
- **WeightStore**: The persistent store of adaptive signal weights, updated by the FeedbackLoop every 10 trades.
- **Regime**: The current market classification — one of `TREND_UP`, `TREND_DOWN`, `SIDEWAY`, `HIGH_VOLATILITY` — produced by the RegimeDetector.
- **AgentState**: The persisted state of the Agent including active strategies, last decision, capital allocation map, and risk counters.
- **DualObjective**: The combined optimization target of DRIFT — Volume × Profit — where both metrics are tracked and balanced simultaneously.

---

## Requirements

### Requirement 1: Agent Lifecycle Management

**User Story:** As a DRIFT operator, I want the Agent to have a well-defined lifecycle (initialize, run, pause, stop), so that I can start and stop autonomous operation safely without leaving open positions or inconsistent state.

#### Acceptance Criteria

1. THE Agent SHALL expose `initialize()`, `start()`, `pause()`, and `stop()` lifecycle methods.
2. WHEN `initialize()` is called, THE Agent SHALL load persisted AgentState from disk, register all configured Strategies, and connect to the BotManager.
3. WHEN `start()` is called, THE Agent SHALL begin executing AgentCycles at a configurable interval (default: 30 seconds).
4. WHEN `pause()` is called, THE Agent SHALL complete the current AgentCycle and then suspend new AgentCycles without closing open positions.
5. WHEN `stop()` is called, THE Agent SHALL complete the current AgentCycle, emit a stop signal to all active bots via BotManager, and persist AgentState to disk before exiting.
6. IF `stop()` is called while a position is open, THEN THE Agent SHALL wait up to 60 seconds for the position to close before forcing a hard stop.
7. THE Agent SHALL persist AgentState to a JSON file at a configurable path (default: `./agent-state.json`) after every AgentCycle.
8. WHEN the Agent process restarts, THE Agent SHALL restore AgentState from disk and resume operation without requiring manual reconfiguration.

---

### Requirement 2: Market Context Observation

**User Story:** As a DRIFT operator, I want the Agent to observe a unified MarketContext at the start of each AgentCycle, so that all decisions are based on a consistent, timestamped snapshot of market and portfolio state.

#### Acceptance Criteria

1. WHEN an AgentCycle begins, THE Agent SHALL assemble a MarketContext containing: current Regime, ConfidenceScore, signal direction, PortfolioState, session PnL, session volume, total open exposure (USD), and timestamp.
2. THE Agent SHALL obtain the Regime from the RegimeDetector using the most recent candle data available from the exchange adapter.
3. THE Agent SHALL obtain the ConfidenceScore and signal direction from the AISignalEngine, using the cached signal if it is less than 60 seconds old.
4. THE Agent SHALL compute PortfolioState by querying BotManager for all active bot states, aggregating open positions, session PnL, and per-strategy volume.
5. IF any data source (exchange adapter, AISignalEngine, RegimeDetector) fails to respond within 10 seconds, THEN THE Agent SHALL use the last known value for that field and mark the MarketContext as `degraded: true`.
6. WHEN MarketContext is `degraded: true`, THE Agent SHALL not open new positions but SHALL continue to monitor and close existing positions.
7. THE Agent SHALL log each MarketContext snapshot with a unique cycle ID for auditability.

---

### Requirement 3: Dual-Mode Strategy Selection

**User Story:** As a DRIFT operator, I want the Agent to automatically select whether to run FARM Mode, TRADE Mode, or both each cycle, so that the system always pursues the best combination of volume and profit given current market conditions.

#### Acceptance Criteria

1. THE StrategySelector SHALL evaluate both FARM and TRADE strategies at the start of each AgentCycle and produce a ranked list of eligible strategies.
2. WHEN Regime is `SIDEWAY`, THE StrategySelector SHALL rank FARM Mode above TRADE Mode, as sideways markets favor mean-reversion volume generation.
3. WHEN Regime is `TREND_UP` or `TREND_DOWN`, THE StrategySelector SHALL rank TRADE Mode above FARM Mode, as trending markets favor directional alpha extraction.
4. WHEN Regime is `HIGH_VOLATILITY` and `REGIME_HIGH_VOL_SKIP_ENTRY` is `true`, THE StrategySelector SHALL mark TRADE Mode as ineligible for the current cycle.
5. THE StrategySelector SHALL always keep FARM Mode eligible unless the RiskGate has issued a `risk_halt` — FARM Mode SHALL NOT be blocked by low confidence scores alone.
6. WHEN a strategy's rolling 10-trade win rate falls below 30%, THE StrategySelector SHALL mark that strategy as ineligible for 3 consecutive cycles (cooldown).
7. THE StrategySelector SHALL always keep at least one strategy eligible per cycle — IF both strategies are ineligible, THEN THE StrategySelector SHALL re-enable the strategy with the highest recent win rate.
8. THE Agent SHALL emit a `strategy_selected` event containing the selected strategy name, Regime, and eligibility scores for observability.
9. WHERE both strategies are eligible simultaneously, THE Agent SHALL activate both concurrently up to the ExposureCap limit, pursuing the DualObjective.

---

### Requirement 4: FARM Mode Execution Requirements

**User Story:** As a DRIFT operator, I want FARM Mode to continuously generate trading volume with controlled risk, so that the system captures platform incentives while maintaining neutral or positive PnL.

#### Acceptance Criteria

1. WHILE FARM Mode is active, THE Agent SHALL ensure at least one FARM bot is always eligible to place a new entry — FARM Mode SHALL NOT require a signal to enter.
2. WHEN no directional signal is available in FARM Mode, THE Agent SHALL instruct the FARM bot to use range positioning or alternate entry direction (mean-reversion).
3. WHEN a directional signal exists in FARM Mode, THE Agent SHALL instruct the FARM bot to follow the signal direction.
4. THE Agent SHALL configure FARM Mode bots with holding cycles between 2 and 8 minutes (120–480 seconds).
5. THE Agent SHALL compute a dynamic take-profit for FARM Mode entries using the formula: `max(FARM_TP_USD, spread_bps × position_value × 1.5)`, where `spread_bps` is the current bid-ask spread in basis points.
6. WHEN a FARM Mode position reaches the dynamic take-profit threshold, THE Agent SHALL trigger an exit regardless of time remaining in the holding cycle.
7. THE Agent SHALL track FARM Mode volume generated per session and expose it in PortfolioState as `farmVolume`.
8. IF FARM Mode PnL for the session falls below `-FARM_MAX_LOSS_USD`, THEN THE Agent SHALL pause FARM Mode entries for the remainder of the session and emit a `farm_loss_halt` event.

---

### Requirement 5: TRADE Mode Execution Requirements

**User Story:** As a DRIFT operator, I want TRADE Mode to extract real market alpha by only trading high-confidence opportunities, so that the system generates genuine PnL without forcing low-quality trades.

#### Acceptance Criteria

1. WHEN evaluating a TRADE Mode entry, THE Agent SHALL apply all of the following filters before authorizing: market regime detection, chop filtering (ChopDetector), fake breakout detection (FakeBreakoutFilter), and ConfidenceScore threshold.
2. THE Agent SHALL only authorize a TRADE Mode entry when ConfidenceScore is greater than or equal to `TRADE_MIN_CONFIDENCE` (default: 0.65).
3. THE Agent SHALL only authorize a TRADE Mode entry when ChopDetector reports a chop score below `TRADE_MAX_CHOP_SCORE` (default: 0.6).
4. THE Agent SHALL only authorize a TRADE Mode entry when FakeBreakoutFilter does not flag the current signal as a fake breakout.
5. WHEN no qualifying signal exists, THE Agent SHALL not force a TRADE Mode entry — TRADE Mode SHALL remain idle rather than place a low-confidence trade.
6. WHILE a TRADE Mode position is open, THE Agent SHALL not apply time-based exits — TRADE Mode positions SHALL only exit via TP or SL triggers from the RiskManager.
7. THE Agent SHALL track TRADE Mode win rate, total PnL, and average holding duration per session and expose these in PortfolioState.
8. WHEN TRADE Mode places an entry, THE Agent SHALL log the full signal snapshot (regime, confidence, chop score, reasoning) for auditability.

---

### Requirement 6: Capital Allocation

**User Story:** As a DRIFT operator, I want the Agent to compute how much capital to allocate to each active strategy per cycle, so that position sizing is risk-adjusted and consistent with portfolio-level constraints.

#### Acceptance Criteria

1. THE CapitalAllocator SHALL compute a target position size (in BTC) for each active strategy using the formula: `baseSize × confidenceMultiplier × performanceMultiplier × regimeVolatilityFactor`.
2. THE CapitalAllocator SHALL clamp the computed size to the range `[ORDER_SIZE_MIN, ORDER_SIZE_MAX]` defined in ConfigStore.
3. WHEN session drawdown exceeds `SIZING_DRAWDOWN_THRESHOLD`, THE CapitalAllocator SHALL apply a `SIZING_DRAWDOWN_FLOOR` multiplier (default: 0.5) to all computed sizes.
4. THE CapitalAllocator SHALL not allocate capital that would cause total open exposure to exceed the configured ExposureCap.
5. WHEN total open exposure is within 80–100% of ExposureCap, THE CapitalAllocator SHALL reduce new allocation sizes by 50%.
6. THE CapitalAllocator SHALL use `SIZING_CONF_WEIGHT` (default: 0.6) and `SIZING_PERF_WEIGHT` (default: 0.4) from ConfigStore when blending confidence and performance multipliers.
7. FOR ALL valid MarketContext inputs, THE CapitalAllocator SHALL produce a size that is greater than zero and less than or equal to `SIZING_MAX_BTC`.
8. THE CapitalAllocator SHALL log the allocation breakdown (baseSize, each multiplier, final size) for every cycle for auditability.
9. WHEN both FARM and TRADE strategies are active simultaneously, THE CapitalAllocator SHALL split available capital between them using the `AGENT_FARM_CAPITAL_RATIO` parameter (default: 0.6 for FARM, 0.4 for TRADE).

---

### Requirement 7: Risk Gate

**User Story:** As a DRIFT operator, I want the Agent to enforce portfolio-level risk rules before authorizing any trade, so that a single bad cycle cannot cause catastrophic loss.

#### Acceptance Criteria

1. THE RiskGate SHALL evaluate every AgentDecision before it is emitted to the execution layer.
2. WHEN session PnL is below the configured `MAX_LOSS` threshold, THE RiskGate SHALL block all new entries and emit a `risk_halt` event.
3. WHEN total open exposure exceeds ExposureCap, THE RiskGate SHALL block all new entries until exposure falls below 90% of ExposureCap.
4. WHEN the Agent has placed 3 consecutive losing trades within a single session, THE RiskGate SHALL enforce a 10-minute cooldown before authorizing the next entry.
5. IF the RiskGate blocks an entry, THEN THE Agent SHALL log the blocking reason, the current PortfolioState, and the blocked AgentDecision.
6. THE RiskGate SHALL not interfere with exit orders — only entry authorization is gated.
7. WHEN a `risk_halt` is active, THE Agent SHALL send a Telegram notification containing the halt reason and current session PnL.
8. THE RiskGate SHALL expose a `getRiskStatus()` method returning the current gate state (`OPEN`, `HALTED`, `COOLDOWN`) and the reason.

---

### Requirement 8: Agent Decision Output

**User Story:** As a DRIFT operator, I want the Agent to produce a structured AgentDecision each cycle, so that downstream components (BotManager, Watcher) receive unambiguous, typed instructions.

#### Acceptance Criteria

1. THE Agent SHALL produce exactly one AgentDecision per AgentCycle.
2. THE AgentDecision SHALL contain: `cycleId` (UUID), `timestamp`, `selectedStrategy` (`FARM` | `TRADE` | `BOTH` | `HOLD`), `direction` (`long` | `short` | `hold`), `allocatedSize` (BTC), `regime`, `confidenceScore`, `riskGateStatus`, and `reasoning` (string).
3. WHEN `selectedStrategy` is `HOLD`, THE Agent SHALL not emit any order to the execution layer.
4. THE Agent SHALL serialize every AgentDecision to the trade log for post-hoc analysis.
5. THE AgentDecision SHALL be immutable after emission — no field may be modified by downstream components.
6. FOR ALL AgentDecisions where `direction` is `long` or `short`, THE `allocatedSize` SHALL be greater than zero.

---

### Requirement 9: Adaptive Learning Integration

**User Story:** As a DRIFT operator, I want the Agent to incorporate feedback from completed trades into future decisions, so that the system improves its strategy selection and capital allocation over time without manual intervention.

#### Acceptance Criteria

1. WHEN a trade is completed (exit filled), THE Agent SHALL record the outcome (win/loss, PnL, strategy used — FARM or TRADE, regime at entry) in the FeedbackLoop.
2. THE Agent SHALL trigger a weight adjustment via AdaptiveWeightAdjuster after every 10 completed trades.
3. THE Agent SHALL update per-strategy win rate statistics after every completed trade and use these statistics in the next StrategySelector evaluation.
4. THE Agent SHALL persist updated WeightStore and strategy performance statistics to disk after every weight adjustment cycle.
5. WHEN a strategy's win rate improves by more than 10 percentage points over 20 trades, THE Agent SHALL log a `strategy_improvement` event.
6. THE Agent SHALL expose a `getPerformanceSummary()` method returning per-strategy (FARM and TRADE) win rate, total trades, total PnL, total volume generated, and current signal weights.
7. FOR ALL weight adjustment cycles, THE adjusted weights SHALL sum to 1.0 and each individual weight SHALL remain within `[0.05, 0.60]`.

---

### Requirement 10: Multi-Bot Coordination

**User Story:** As a DRIFT operator, I want the Agent to coordinate multiple bot instances running different strategies simultaneously, so that capital is deployed efficiently across exchanges without conflicting positions or duplicate exposure.

#### Acceptance Criteria

1. THE Agent SHALL query BotManager for all registered bot instances at the start of each AgentCycle.
2. WHEN assigning a strategy to a bot, THE Agent SHALL prefer bots whose exchange matches the strategy's configured preferred exchange.
3. THE Agent SHALL not assign the same directional trade (e.g., two concurrent LONG positions on BTC-USD) to more than one bot unless the combined exposure remains below ExposureCap.
4. WHEN a bot is in `COOLDOWN` or `EXITING` state, THE Agent SHALL not assign a new entry to that bot for the current cycle.
5. THE Agent SHALL track per-bot exposure and aggregate it into PortfolioState every cycle.
6. IF a bot becomes unreachable (no state update for more than 60 seconds), THEN THE Agent SHALL mark that bot as `STALE` and exclude it from capital allocation until it recovers.
7. THE Agent SHALL emit a `bot_assignment` event for each bot-strategy assignment, containing bot ID, strategy name (`FARM` or `TRADE`), direction, and allocated size.

---

### Requirement 11: Observability and Auditability

**User Story:** As a DRIFT operator, I want full visibility into every Agent decision and its rationale, so that I can audit performance, debug issues, and build trust in the autonomous system.

#### Acceptance Criteria

1. THE Agent SHALL emit structured log entries for every AgentCycle containing: cycle ID, duration (ms), MarketContext summary, AgentDecision, RiskGate status, and DualObjective metrics (session volume, session PnL).
2. THE Agent SHALL expose a `/agent/status` HTTP endpoint on the dashboard server returning the current AgentState, last AgentDecision, PortfolioState, and DualObjective metrics.
3. THE Agent SHALL expose a `/agent/history` HTTP endpoint returning the last 100 AgentDecisions in reverse chronological order.
4. WHEN the Agent transitions between lifecycle states (e.g., `RUNNING` → `PAUSED`), THE Agent SHALL send a Telegram notification with the new state and reason.
5. THE Agent SHALL track and expose cycle latency (p50, p95, p99 over the last 100 cycles) via the `/agent/status` endpoint.
6. THE Agent SHALL write a human-readable `reasoning` string in every AgentDecision explaining why the selected strategy (FARM, TRADE, or BOTH) and direction were chosen.
7. WHEN an AgentCycle takes longer than 10 seconds, THE Agent SHALL log a `slow_cycle` warning with the cycle ID and actual duration.

---

### Requirement 12: Configuration and Runtime Control

**User Story:** As a DRIFT operator, I want to configure and override Agent behavior at runtime without restarting the process, so that I can tune the system in response to changing market conditions.

#### Acceptance Criteria

1. THE Agent SHALL read its configuration from ConfigStore, inheriting all existing runtime-overridable parameters.
2. THE Agent SHALL support the following Agent-specific runtime parameters: `AGENT_CYCLE_INTERVAL_SECS` (default: 30), `AGENT_EXPOSURE_CAP_USD` (default: 500), `AGENT_CONSECUTIVE_LOSS_HALT` (default: 3), `AGENT_LOSS_COOLDOWN_MINS` (default: 10), `AGENT_FARM_CAPITAL_RATIO` (default: 0.6), `TRADE_MIN_CONFIDENCE` (default: 0.65), `TRADE_MAX_CHOP_SCORE` (default: 0.6).
3. WHEN a runtime configuration change is applied via ConfigStore, THE Agent SHALL apply the new values on the next AgentCycle without restarting.
4. THE Agent SHALL expose a `/agent/config` HTTP endpoint (GET) returning all current Agent configuration values.
5. THE Agent SHALL expose a `/agent/config` HTTP endpoint (PATCH) accepting partial configuration overrides, validating them, and applying them immediately.
6. IF an invalid configuration value is submitted (e.g., `AGENT_CYCLE_INTERVAL_SECS < 5`), THEN THE Agent SHALL reject the request with a descriptive error message and leave the current configuration unchanged.
7. THE Agent SHALL support a `AGENT_DRY_RUN` flag (default: `false`) that, when `true`, causes the Agent to produce AgentDecisions and log them without emitting any orders to the execution layer.
