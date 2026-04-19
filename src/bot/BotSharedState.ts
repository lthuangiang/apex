import type { PnlDataPoint, EventLogEntry, OpenPositionState } from '../ai/sharedState.js';

/**
 * Per-bot shared state interface
 * Each bot instance has its own isolated state
 */
export interface BotSharedState {
  botId: string;
  sessionPnl: number;
  sessionVolume: number;
  sessionFees: number;
  todayVolume: number;
  todayVolumeDate: string;
  updatedAt: string;
  botStatus: 'RUNNING' | 'STOPPED';
  symbol: string;
  walletAddress: string;
  pnlHistory: PnlDataPoint[];
  volumeHistory: PnlDataPoint[];
  eventLog: EventLogEntry[];
  openPosition: OpenPositionState | null;
}

/**
 * Factory function to create a new BotSharedState instance
 * @param botId - Unique identifier for the bot
 * @returns A new BotSharedState object with default values
 */
export function createBotSharedState(botId: string): BotSharedState {
  return {
    botId,
    sessionPnl: 0,
    sessionVolume: 0,
    sessionFees: 0,
    todayVolume: 0,
    todayVolumeDate: new Date().toISOString().slice(0, 10),
    updatedAt: new Date().toISOString(),
    botStatus: 'STOPPED',
    symbol: '',
    walletAddress: '',
    pnlHistory: [],
    volumeHistory: [],
    eventLog: [],
    openPosition: null,
  };
}

// SSE client management per bot
const botSseClients = new Map<string, Set<(data: string) => void>>();

export function addSseClient(botId: string, send: (data: string) => void): void {
  if (!botSseClients.has(botId)) {
    botSseClients.set(botId, new Set());
  }
  botSseClients.get(botId)!.add(send);
}

export function removeSseClient(botId: string, send: (data: string) => void): void {
  const clients = botSseClients.get(botId);
  if (clients) {
    clients.delete(send);
    if (clients.size === 0) {
      botSseClients.delete(botId);
    }
  }
}

export function logEvent(botId: string, state: BotSharedState, type: EventLogEntry['type'], message: string): void {
  const entry: EventLogEntry = {
    time: new Date().toISOString(),
    type,
    message,
  };
  
  state.eventLog.unshift(entry);
  if (state.eventLog.length > 200) {
    state.eventLog.length = 200;
  }
  
  // Push to SSE clients for this bot
  const clients = botSseClients.get(botId);
  if (clients && clients.size > 0) {
    const payload = JSON.stringify(entry);
    clients.forEach(send => send(payload));
  }
}
