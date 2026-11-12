// Giới hạn kết nối WebSocket SoDEX (docs/SODEX.md mục 5.6).
export const WS_MAX_CONNECTIONS_PER_IP = 10;
export const WS_MAX_UNIQUE_USERS_PER_IP = 10;
export const WS_PING_INTERVAL_MS = 30_000;
/**
 * Stream giá không có nến / mark price trong ngần này thì coi là chết và nối lại, kể cả khi SoDEX vẫn trả pong
 * (2026-11-08: marketdata local đứng 33 phút, Redis hết `md:last:*`, bot không Start được vì "no live price").
 */
export const WS_MARKET_STALE_MS = 90_000;
export const WS_RECONNECT_BASE_MS = 1_000;
export const WS_RECONNECT_MAX_MS = 30_000;

/** Backoff mũ với jitter tối đa 25%. */
export function reconnectDelay(attempt: number): number {
  const base = Math.min(WS_RECONNECT_BASE_MS * 2 ** attempt, WS_RECONNECT_MAX_MS);
  return base + Math.floor(Math.random() * base * 0.25);
}
