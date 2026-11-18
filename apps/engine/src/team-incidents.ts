import {
  ENGINE_HEALTH_TTL_MS,
  engineHealthKey,
  ReasonCode,
  TEAM_INCIDENT_DETAIL_MAX,
  type EngineHealthSignal,
  type ReasonCode as Reason,
  type TeamIncidentKind,
} from "@drift/shared";

// Báo team sự cố tiền thật (#241, DEC-313). Engine chỉ thêm MỘT dòng outbox `jobs.team_ops` trong
// transaction đang ghi sự kiện (Decisions / cờ của bot), không chờ gì thêm; jobs chặn lặp và gửi Telegram cho team.
// Không bao giờ email, ví, key: chỉ bot id, market và số liệu ngắn.

/** Dòng outbox cho một sự cố theo bot. `detail` bị cắt cho vừa schema (jobs parse bằng zod). */
export function teamIncidentRow(e: {
  kind: TeamIncidentKind;
  botId: string;
  market?: string;
  detail: string;
}): { topic: string; payload: Record<string, unknown> } {
  return {
    topic: "jobs.team_ops",
    payload: {
      type: "team_incident",
      kind: e.kind,
      botId: e.botId,
      ...(e.market === undefined ? {} : { market: e.market.slice(0, 40) }),
      detail: e.detail.slice(0, TEAM_INCIDENT_DETAIL_MAX),
    },
  };
}

/** Lý do pause được báo team: lỗi khi gửi lệnh (không phải pause theo kế hoạch / giới hạn rủi ro). */
export const TEAM_PAUSE_REASONS: readonly Reason[] = [
  ReasonCode.orderRejected,
  ReasonCode.apiKeyUnusable,
];

/**
 * Bộ đếm theo phút của tín hiệu sức khoẻ engine (Redis INCRBY + PEXPIRE). Không chờ, không ném: Redis lỗi thì bỏ lần
 * đếm, không bao giờ làm chậm hay hỏng vòng giao dịch.
 */
export function redisEngineHealth(
  redis: {
    multi(): {
      incrby(key: string, n: number): unknown;
      pexpire(key: string, ms: number): unknown;
      exec(): Promise<unknown>;
    };
  },
  now: () => number = Date.now,
): (signal: EngineHealthSignal, n?: number) => void {
  return (signal, n = 1) => {
    try {
      const key = engineHealthKey(signal, Math.floor(now() / 60_000));
      const m = redis.multi();
      m.incrby(key, n);
      m.pexpire(key, ENGINE_HEALTH_TTL_MS);
      void m.exec().catch(() => undefined);
    } catch {
      // Bỏ qua: bộ đếm chỉ để báo team.
    }
  };
}
