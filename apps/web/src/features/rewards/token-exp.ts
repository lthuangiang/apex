import { jwtExpiryMs } from "./jwt-exp";
import { readRewardsToken } from "./token-store";

// Hạn đăng nhập rewards (#575 PR 3/3): chỉ đọc claim `exp` (giây) của JWT trong localStorage để hiện "Expires {date}".
// Không trả, không log token; chỉ trả số mili giây. Token lệch dạng hoặc không có `exp` → null.

export function rewardsExpiryMs(address: string | null): number | null {
  const token = readRewardsToken(address);
  return token === null ? null : jwtExpiryMs(token);
}
