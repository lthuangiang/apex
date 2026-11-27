import { readRewardsToken } from "./token-store";

// Hạn đăng nhập rewards (#575 PR 3/3): chỉ đọc claim `exp` (giây) của JWT trong sessionStorage để hiện "Expires {date}".
// Không trả, không log token; chỉ trả số mili giây. Token lệch dạng hoặc không có `exp` → null.

export function rewardsExpiryMs(address: string | null): number | null {
  const token = readRewardsToken(address);
  if (token === null) return null;
  const part = token.split(".")[1];
  if (part === undefined) return null;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4))) as unknown;
    if (typeof json !== "object" || json === null) return null;
    const exp = (json as { exp?: unknown }).exp;
    return typeof exp === "number" && Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
  } catch {
    return null;
  }
}
