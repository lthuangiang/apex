/**
 * Backtest API Routes
 *
 * Exposes REST + SSE endpoints for the backtesting engine:
 *   POST   /api/backtest/run          — start a new backtest run
 *   GET    /api/backtest/status/:runId — get run progress
 *   GET    /api/backtest/result/:runId — get completed result
 *   GET    /api/backtest/stream/:runId — SSE progress stream
 *   DELETE /api/backtest/:runId        — abort an active run
 *   GET    /api/backtest/history       — last 50 completed runs
 *
 * Requirements: 6.1–6.12
 */

import { randomUUID } from 'crypto';
import express, { Request, Response } from 'express';
import type {
  BacktestRunConfig,
  BacktestResult,
  BacktestProgress,
} from '../../backtest/types.js';
import { BacktestRunner } from '../../backtest/BacktestRunner.js';
import { HistoricalDataFeed } from '../../backtest/HistoricalDataFeed.js';

// ---------------------------------------------------------------------------
// Valid enum values for validation
// ---------------------------------------------------------------------------

const VALID_INTERVALS = new Set(['1m', '5m', '15m', '1h', '4h', '1d']);
const VALID_DATA_SOURCES = new Set(['local', 'exchange_api', 'auto']);
const VALID_FILL_MODES = new Set(['optimistic', 'realistic', 'pessimistic']);

// ---------------------------------------------------------------------------
// RunState — per-run in-memory state
// ---------------------------------------------------------------------------

interface RunState {
  runId: string;
  runner: BacktestRunner;
  /** Current progress snapshot (updated via onProgress callback). */
  progress: BacktestProgress;
  /** Completed result — set when run finishes or is aborted. */
  result: BacktestResult | null;
  /** Whether the run is still executing. */
  active: boolean;
  /** ISO timestamp when the run was started. */
  startedAt: string;
  /** SSE response objects subscribed to this run's stream. */
  sseClients: Set<Response>;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

interface ValidationError {
  field: string;
  message: string;
}

/**
 * Validate a BacktestRunConfig body.
 * Returns an array of field-level errors (empty = valid).
 *
 * Requirements: 6.2, 8.1–8.12
 */
function validateRunConfig(body: Record<string, unknown>): ValidationError[] {
  const errors: ValidationError[] = [];

  // Required string fields
  if (!body.botId || typeof body.botId !== 'string' || body.botId.trim() === '') {
    errors.push({ field: 'botId', message: 'botId is required and must be a non-empty string' });
  }

  // from / to — required ISO date strings
  if (!body.from || typeof body.from !== 'string') {
    errors.push({ field: 'from', message: 'from is required (ISO date string, e.g. "2024-01-01")' });
  }
  if (!body.to || typeof body.to !== 'string') {
    errors.push({ field: 'to', message: 'to is required (ISO date string, e.g. "2024-03-31")' });
  }

  // Date range: from < to
  if (body.from && body.to && typeof body.from === 'string' && typeof body.to === 'string') {
    const fromMs = Date.parse(body.from as string);
    const toMs = Date.parse(body.to as string);
    if (isNaN(fromMs)) {
      errors.push({ field: 'from', message: 'from is not a valid date string' });
    } else if (isNaN(toMs)) {
      errors.push({ field: 'to', message: 'to is not a valid date string' });
    } else if (fromMs >= toMs) {
      errors.push({ field: 'from', message: 'from must be strictly before to' });
    }
  }

  // interval — required enum
  if (!body.interval) {
    errors.push({ field: 'interval', message: 'interval is required' });
  } else if (!VALID_INTERVALS.has(body.interval as string)) {
    errors.push({
      field: 'interval',
      message: `interval must be one of: ${[...VALID_INTERVALS].join(', ')}`,
    });
  }

  // initialBalance — required, > 0, within [0.01, 1_000_000_000]
  if (body.initialBalance === undefined || body.initialBalance === null) {
    errors.push({ field: 'initialBalance', message: 'initialBalance is required' });
  } else {
    const bal = Number(body.initialBalance);
    if (isNaN(bal) || bal <= 0) {
      errors.push({ field: 'initialBalance', message: 'initialBalance must be a number greater than 0' });
    } else if (bal < 0.01 || bal > 1_000_000_000) {
      errors.push({
        field: 'initialBalance',
        message: 'initialBalance must be in the range [0.01, 1,000,000,000]',
      });
    }
  }

  // makerFeeBps — required, integer [0, 10000]
  if (body.makerFeeBps === undefined || body.makerFeeBps === null) {
    errors.push({ field: 'makerFeeBps', message: 'makerFeeBps is required' });
  } else {
    const v = Number(body.makerFeeBps);
    if (!Number.isInteger(v) || v < 0 || v > 10000) {
      errors.push({ field: 'makerFeeBps', message: 'makerFeeBps must be an integer in [0, 10000]' });
    }
  }

  // takerFeeBps — required, integer [0, 10000]
  if (body.takerFeeBps === undefined || body.takerFeeBps === null) {
    errors.push({ field: 'takerFeeBps', message: 'takerFeeBps is required' });
  } else {
    const v = Number(body.takerFeeBps);
    if (!Number.isInteger(v) || v < 0 || v > 10000) {
      errors.push({ field: 'takerFeeBps', message: 'takerFeeBps must be an integer in [0, 10000]' });
    }
  }

  // slippageBps — required, integer [0, 10000]
  if (body.slippageBps === undefined || body.slippageBps === null) {
    errors.push({ field: 'slippageBps', message: 'slippageBps is required' });
  } else {
    const v = Number(body.slippageBps);
    if (!Number.isInteger(v) || v < 0 || v > 10000) {
      errors.push({ field: 'slippageBps', message: 'slippageBps must be an integer in [0, 10000]' });
    }
  }

  // dataSource — required enum
  if (!body.dataSource) {
    errors.push({ field: 'dataSource', message: 'dataSource is required' });
  } else if (!VALID_DATA_SOURCES.has(body.dataSource as string)) {
    errors.push({
      field: 'dataSource',
      message: `dataSource must be one of: ${[...VALID_DATA_SOURCES].join(', ')}`,
    });
  }

  // fillMode — optional enum
  if (body.fillMode !== undefined && body.fillMode !== null) {
    if (!VALID_FILL_MODES.has(body.fillMode as string)) {
      errors.push({
        field: 'fillMode',
        message: `fillMode must be one of: ${[...VALID_FILL_MODES].join(', ')}`,
      });
    }
  }

  // speedMultiplier — optional, must be >= 0 if provided
  if (body.speedMultiplier !== undefined && body.speedMultiplier !== null) {
    const v = Number(body.speedMultiplier);
    if (isNaN(v) || v < 0) {
      errors.push({ field: 'speedMultiplier', message: 'speedMultiplier must be a non-negative number' });
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// createBacktestRouter
// ---------------------------------------------------------------------------

/**
 * Create and return an Express router for all backtest API endpoints.
 *
 * @param dataFeed - Shared HistoricalDataFeed instance used by all runners.
 *
 * Requirements: 6.1–6.12
 */
export function createBacktestRouter(dataFeed: HistoricalDataFeed): express.Router {
  const router = express.Router();

  /**
   * In-memory run registry.
   * Maps runId → RunState.
   * Requirement 6.12 — each runId's data is isolated.
   */
  const runs = new Map<string, RunState>();

  /**
   * Completed run history (for GET /history).
   * Capped at 50 entries, sorted by startedAt descending.
   * Requirement 6.11
   */
  const completedHistory: BacktestResult[] = [];
  const HISTORY_LIMIT = 50;

  // -------------------------------------------------------------------------
  // Helper: push SSE event to all clients subscribed to a runId
  // -------------------------------------------------------------------------

  function pushSseEvent(runId: string, payload: Record<string, unknown>): void {
    const state = runs.get(runId);
    if (!state) return;
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of state.sseClients) {
      try {
        client.write(data);
      } catch {
        // Client disconnected — will be cleaned up on 'close' event
      }
    }
  }

  // -------------------------------------------------------------------------
  // Helper: record a completed result in history
  // -------------------------------------------------------------------------

  function recordHistory(result: BacktestResult): void {
    completedHistory.unshift(result);
    if (completedHistory.length > HISTORY_LIMIT) {
      completedHistory.splice(HISTORY_LIMIT);
    }
  }

  // -------------------------------------------------------------------------
  // POST /run — start a new backtest run
  // Requirement 6.1, 6.2
  // -------------------------------------------------------------------------

  router.post('/run', (req: Request, res: Response): void => {
    const body = req.body as Record<string, unknown>;

    // Validate config
    const errors = validateRunConfig(body);
    if (errors.length > 0) {
      res.status(400).json({ errors });
      return;
    }

    const config = body as unknown as BacktestRunConfig;
    const runId = randomUUID();
    const startedAt = new Date().toISOString();

    // Initial progress state
    const initialProgress: BacktestProgress = {
      runId,
      processed: 0,
      total: 0,
      currentBalance: config.initialBalance,
      currentEquity: config.initialBalance,
      percentComplete: 0,
    };

    // Build the runner with a progress callback that updates state and pushes SSE
    const runner = new BacktestRunner(config, dataFeed, (progress: BacktestProgress) => {
      const state = runs.get(runId);
      if (!state) return;
      state.progress = progress;
      // Push SSE progress event (Requirement 6.7)
      pushSseEvent(runId, {
        type: 'progress',
        processed: progress.processed,
        total: progress.total,
        currentBalance: progress.currentBalance,
        currentEquity: progress.currentEquity,
        percentComplete: progress.percentComplete,
      });
    });

    const runState: RunState = {
      runId,
      runner,
      progress: initialProgress,
      result: null,
      active: true,
      startedAt,
      sseClients: new Set(),
    };

    runs.set(runId, runState);

    // Start the run in the background (fire-and-forget)
    runner.run().then((result: BacktestResult) => {
      const state = runs.get(runId);
      if (!state) return;

      state.result = result;
      state.active = false;

      // Record in history
      recordHistory(result);

      // Push final SSE event (Requirement 6.7)
      if (result.status === 'aborted') {
        pushSseEvent(runId, { type: 'aborted', result });
      } else if (result.status === 'completed') {
        pushSseEvent(runId, { type: 'complete', result });
      } else {
        // error status
        pushSseEvent(runId, { type: 'error', message: result.error ?? 'Backtest failed' });
      }

      // Close all SSE connections for this run
      for (const client of state.sseClients) {
        try { client.end(); } catch { /* ignore */ }
      }
      state.sseClients.clear();
    }).catch((err: unknown) => {
      const state = runs.get(runId);
      if (!state) return;
      state.active = false;
      const message = err instanceof Error ? err.message : String(err);
      pushSseEvent(runId, { type: 'error', message });
      for (const client of state.sseClients) {
        try { client.end(); } catch { /* ignore */ }
      }
      state.sseClients.clear();
    });

    // Return 202 with runId immediately (Requirement 6.1)
    res.status(202).json({ runId });
  });

  // -------------------------------------------------------------------------
  // GET /status/:runId — current progress
  // Requirement 6.3, 6.4
  // -------------------------------------------------------------------------

  router.get('/status/:runId', (req: Request, res: Response): void => {
    const runId = req.params['runId'] as string;
    const state = runs.get(runId);

    if (!state) {
      res.status(404).json({ error: 'Run not found', runId });
      return;
    }

    const { progress, result, active } = state;

    // Determine status string
    let status: string;
    if (active) {
      status = 'running';
    } else if (result) {
      status = result.status;
    } else {
      status = 'unknown';
    }

    res.status(200).json({
      runId,
      status,
      processed: progress.processed,
      total: progress.total,
      currentBalance: progress.currentBalance,
    });
  });

  // -------------------------------------------------------------------------
  // GET /result/:runId — full BacktestResult
  // Requirement 6.5, 6.6
  // -------------------------------------------------------------------------

  router.get('/result/:runId', (req: Request, res: Response): void => {
    const runId = req.params['runId'] as string;
    const state = runs.get(runId);

    if (!state) {
      res.status(404).json({ error: 'Run not found', runId });
      return;
    }

    if (state.active || !state.result) {
      // Still running
      res.status(202).json({ status: 'running' });
      return;
    }

    res.status(200).json(state.result);
  });

  // -------------------------------------------------------------------------
  // GET /stream/:runId — SSE progress stream
  // Requirement 6.7, 6.8
  // -------------------------------------------------------------------------

  router.get('/stream/:runId', (req: Request, res: Response): void => {
    const runId = req.params['runId'] as string;
    const state = runs.get(runId);

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    if (!state) {
      // Unknown runId — send error event and close (Requirement 6.8)
      res.write(`data: ${JSON.stringify({ type: 'error', message: 'Run not found' })}\n\n`);
      res.end();
      return;
    }

    // If run already completed, send the final event immediately and close
    if (!state.active && state.result) {
      const result = state.result;
      if (result.status === 'aborted') {
        res.write(`data: ${JSON.stringify({ type: 'aborted', result })}\n\n`);
      } else if (result.status === 'completed') {
        res.write(`data: ${JSON.stringify({ type: 'complete', result })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ type: 'error', message: result.error ?? 'Backtest failed' })}\n\n`);
      }
      res.end();
      return;
    }

    // Register this client for live events
    state.sseClients.add(res);

    // Send current progress immediately so the client has an initial state
    res.write(`data: ${JSON.stringify({
      type: 'progress',
      processed: state.progress.processed,
      total: state.progress.total,
      currentBalance: state.progress.currentBalance,
      currentEquity: state.progress.currentEquity,
      percentComplete: state.progress.percentComplete,
    })}\n\n`);

    // Clean up when client disconnects
    req.on('close', () => {
      state.sseClients.delete(res);
    });
  });

  // -------------------------------------------------------------------------
  // DELETE /:runId — abort an active run
  // Requirement 6.9, 6.10
  // -------------------------------------------------------------------------

  router.delete('/:runId', (req: Request, res: Response): void => {
    const runId = req.params['runId'] as string;
    const state = runs.get(runId);

    if (!state || !state.active) {
      res.status(404).json({ error: 'Active run not found', runId });
      return;
    }

    state.runner.abort();
    res.status(200).json({ ok: true, runId });
  });

  // -------------------------------------------------------------------------
  // GET /history — last 50 completed runs
  // Requirement 6.11
  // -------------------------------------------------------------------------

  router.get('/history', (_req: Request, res: Response): void => {
    // Return summary fields only, sorted by startedAt descending (already maintained)
    const summaries = completedHistory.map((r) => ({
      runId: r.runId,
      status: r.status,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
      botName: (r.config.botConfig as Record<string, unknown> | undefined)?.['name'] ?? r.config.botId,
      from: r.config.from,
      to: r.config.to,
      interval: r.config.interval,
      totalPnl: r.metrics.totalPnl,
      winRate: r.metrics.winRate,
      totalTrades: r.metrics.totalTrades,
      maxDrawdown: r.metrics.maxDrawdown,
      sharpeRatio: r.metrics.sharpeRatio,
    }));

    res.status(200).json(summaries);
  });

  return router;
}
