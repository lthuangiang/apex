// #558 (DEC-398): đọc claim của JWT rewards (không kiểm chữ ký: DeskLabs không có khoá của SoDEX). Chỉ để biết hạn và
// phạm vi token trước khi lưu ở server. Không bao giờ trả lại hay log token. Thuần, không I/O.

/** Hạn JWT đo bằng ví thật là 15 ngày; cho dư 1 ngày. Dài hơn là bất thường, từ chối. */
export const REWARDS_JWT_MAX_LIFETIME_S = 16 * 24 * 60 * 60;
/** Token còn dưới 1 giờ thì không lưu (job sẽ dừng gần như ngay). */
export const REWARDS_JWT_MIN_REMAINING_S = 60 * 60;

export interface RewardsJwtClaims {
  exp: number;
  iat: number | null;
  aud: string[];
  iss: string | null;
  /** 8 ký tự đầu của `jti` (không bí mật, chỉ để đối chiếu audit). */
  jti8: string | null;
}

export type RewardsTokenProblem =
  "malformed" | "no_exp" | "expired" | "lifetime_too_long" | "aud_missing" | "aud_not_allowed";

function decodePart(part: string): unknown {
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

/** Claim của JWT, hoặc lý do không dùng được. Không kiểm `aud` theo danh sách (xem `checkRewardsAud`). */
export function readRewardsJwtClaims(
  token: string,
  nowMs: number,
): RewardsJwtClaims | { problem: RewardsTokenProblem } {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[1] === undefined) return { problem: "malformed" };
  let payload: unknown;
  try {
    payload = decodePart(parts[1]);
  } catch {
    return { problem: "malformed" };
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload))
    return { problem: "malformed" };
  const p = payload as Record<string, unknown>;
  const exp = typeof p.exp === "number" && Number.isFinite(p.exp) ? p.exp : null;
  if (exp === null) return { problem: "no_exp" };
  const iat = typeof p.iat === "number" && Number.isFinite(p.iat) ? p.iat : null;
  if (exp * 1000 < nowMs + REWARDS_JWT_MIN_REMAINING_S * 1000) return { problem: "expired" };
  const start = iat ?? nowMs / 1000;
  if (exp - start > REWARDS_JWT_MAX_LIFETIME_S) return { problem: "lifetime_too_long" };
  const rawAud = p.aud;
  const aud =
    typeof rawAud === "string"
      ? [rawAud]
      : Array.isArray(rawAud) && rawAud.every((a): a is string => typeof a === "string")
        ? rawAud
        : [];
  const iss = typeof p.iss === "string" ? p.iss : null;
  const jti8 = typeof p.jti === "string" && p.jti !== "" ? p.jti.slice(0, 8) : null;
  return { exp, iat, aud, iss, jti8 };
}

/**
 * Mọi giá trị `aud` phải nằm trong danh sách cho phép (`REWARDS_JWT_AUD_ALLOW`). Danh sách trống = từ chối mọi token
 * (an toàn khi chưa cấu hình). Token không có `aud` cũng bị từ chối.
 */
export function checkRewardsAud(
  aud: readonly string[],
  allow: readonly string[],
): RewardsTokenProblem | null {
  if (aud.length === 0) return "aud_missing";
  if (allow.length === 0) return "aud_not_allowed";
  return aud.every((a) => allow.includes(a)) ? null : "aud_not_allowed";
}
