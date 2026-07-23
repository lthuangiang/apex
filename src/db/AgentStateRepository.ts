/**
 * AgentStateRepository — SQLite-backed agent layer state persistence.
 *
 * Replaces agent-state.json file I/O in AgentLayer._persistState / _loadState.
 */

import { getDb } from './Database.js';

export interface AgentStateRow {
  decisionHistory: unknown[];
  cycleCount: number;
  cycleLatencies: number[];
  strategyPerformance: Record<string, unknown>;
  totalCycleTimeMs: number;
  lifecycleState: string;
  savedAt: string;
}

/**
 * Load agent state from SQLite.
 * Returns null if no state persisted yet.
 */
export function loadAgentState(): AgentStateRow | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT decision_history, cycle_count, cycle_latencies,
           strategy_performance, total_cycle_time_ms, lifecycle_state, saved_at
    FROM agent_state WHERE id = 1
  `).get() as Record<string, unknown> | undefined;

  if (!row) return null;

  return {
    decisionHistory: JSON.parse(row['decision_history'] as string),
    cycleCount: row['cycle_count'] as number,
    cycleLatencies: JSON.parse(row['cycle_latencies'] as string),
    strategyPerformance: JSON.parse(row['strategy_performance'] as string),
    totalCycleTimeMs: row['total_cycle_time_ms'] as number,
    lifecycleState: row['lifecycle_state'] as string,
    savedAt: row['saved_at'] as string,
  };
}

/**
 * Upsert agent state into SQLite.
 */
export function saveAgentState(state: Omit<AgentStateRow, 'savedAt'>): void {
  const db = getDb();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT OR REPLACE INTO agent_state (
      id, decision_history, cycle_count, cycle_latencies,
      strategy_performance, total_cycle_time_ms, lifecycle_state, saved_at
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    JSON.stringify(state.decisionHistory),
    state.cycleCount,
    JSON.stringify(state.cycleLatencies),
    JSON.stringify(state.strategyPerformance),
    state.totalCycleTimeMs,
    state.lifecycleState,
    now,
  );
}
