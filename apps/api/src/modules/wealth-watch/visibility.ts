import type { Db } from "@drift/db";

import { isTeamUser } from "../bots/service";

// Ai dùng được cảnh báo SoDEX Wealth (#594, DEC-404 mục 1): US Market bật (`US_MARKET_ENABLED`, không thì không có tab
// My Wealth) và (công tắc hệ thống `WEALTH_WATCH_ENABLED` bật, hoặc user là team để thử bằng ví thật khi công tắc tắt).
// Một hàm cho `/api/v1/features.wealthAlerts`, route `/api/v1/wealth/watch` và nhóm thông báo `wealth` trong Settings.

export interface WealthWatchSwitches {
  usMarket: () => boolean;
  enabled: () => boolean;
}

export async function wealthAlertsVisibleTo(
  db: Db,
  switches: WealthWatchSwitches | undefined,
  userId: string | null,
): Promise<boolean> {
  if (switches === undefined || !switches.usMarket() || userId === null) return false;
  if (switches.enabled()) return true;
  return isTeamUser(db, userId);
}
