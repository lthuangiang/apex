// Giới hạn kết nối WebSocket SoDEX (docs/SODEX.md mục 5.6).
export const WS_MAX_CONNECTIONS_PER_IP = 10;
export const WS_MAX_UNIQUE_USERS_PER_IP = 10;
export const WS_PING_INTERVAL_MS = 30_000;
export const WS_RECONNECT_BASE_MS = 1_000;
export const WS_RECONNECT_MAX_MS = 30_000;

/** Backoff mũ với jitter tối đa 25%. */
export function reconnectDelay(attempt: number): number {
  const base = Math.min(WS_RECONNECT_BASE_MS * 2 ** attempt, WS_RECONNECT_MAX_MS);
  return base + Math.floor(Math.random() * base * 0.25);
}
