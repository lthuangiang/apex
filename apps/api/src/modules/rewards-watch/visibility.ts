import type { Db } from "@drift/db";

import { isTeamUser } from "../bots/service";

// Ai thấy SoDEX rewards (DEC-397, #551): công tắc toàn hệ thống `REWARDS_ENABLED` bật, hoặc user là team (thử bằng ví
// thật khi công tắc tắt). Một hàm cho `/api/v1/features.sodexRewards` và nhóm thông báo `rewards` trong Settings (#558),
// để hai nơi không lệch nhau.

export async function rewardsVisibleTo(
  db: Db,
  rewardsEnabled: (() => boolean) | undefined,
  userId: string | null,
): Promise<boolean> {
  if (rewardsEnabled?.() === true) return true;
  return userId !== null && (await isTeamUser(db, userId));
}
