export interface PnlDataPoint {
  time: string;
  value: number;
}

export interface EventLogEntry {
  time: string;
  type: 'INFO' | 'ORDER_PLACED' | 'ORDER_FILLED' | 'ERROR' | 'WARN';
  message: string;
}

export interface OpenPositionState {
  symbol: string;
  side: 'long' | 'short';
  size: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  durationSecs: number;
  /** Milliseconds remaining in farm hold period. null = no hold active or trade mode. */
  holdRemainingMs: number | null;
}

export const sharedState = {
  sessionPnl: 0,
  sessionVolume: 0,
  updatedAt: new Date().toISOString(),
  botStatus: 'STOPPED' as 'RUNNING' | 'STOPPED',
  symbol: 'BTC-USD',
  walletAddress: '',
  pnlHistory: [] as PnlDataPoint[],
  volumeHistory: [] as PnlDataPoint[],
  eventLog: [] as EventLogEntry[],
  openPosition: null as OpenPositionState | null,
};

// SSE subscribers for realtime log streaming
const sseClients = new Set<(data: string) => void>();

export function addSseClient(send: (data: string) => void) {
  sseClients.add(send);
}

export function removeSseClient(send: (data: string) => void) {
  sseClients.delete(send);
}

export function logEvent(type: EventLogEntry['type'], message: string) {
  const entry: EventLogEntry = {
    time: new Date().toISOString(),
    type,
    message,
  };
  sharedState.eventLog.unshift(entry);
  if (sharedState.eventLog.length > 200) {
    sharedState.eventLog.length = 200;
  }
  // Push to SSE clients
  const payload = JSON.stringify(entry);
  sseClients.forEach(send => send(payload));
  // Persist state after each event (debounced)
  import('./StateStore.js').then(m => m.saveState()).catch(() => {});
}


// SSE subscribers for raw console/stdout streaming
const consoleSseClients = new Set<(data: string) => void>();

export function addConsoleSseClient(send: (data: string) => void) {
  consoleSseClients.add(send);
}

export function removeConsoleSseClient(send: (data: string) => void) {
  consoleSseClients.delete(send);
}

/** Intercept process stdout/stderr and forward to SSE clients */
export function interceptConsole() {
  const forward = (chunk: string) => {
    if (consoleSseClients.size === 0) return;
    const lines = chunk.split('\n').filter(l => l.trim());
    const time = new Date().toISOString();
    lines.forEach(line => {
      const payload = JSON.stringify({ time, line });
      consoleSseClients.forEach(send => send(payload));
    });
  };

  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);

  (process.stdout as any).write = (chunk: any, ...args: any[]) => {
    if (typeof chunk === 'string') forward(chunk);
    else if (Buffer.isBuffer(chunk)) forward(chunk.toString());
    return origStdoutWrite(chunk, ...args);
  };

  (process.stderr as any).write = (chunk: any, ...args: any[]) => {
    if (typeof chunk === 'string') forward(chunk);
    else if (Buffer.isBuffer(chunk)) forward(chunk.toString());
    return origStderrWrite(chunk, ...args);
  };
}
