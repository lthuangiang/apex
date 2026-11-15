"use client";

import { Strategy, type AdminUserDetail } from "@drift/shared";
import { useTranslations } from "next-intl";

// Cost per $1M volume của một bot ở Team › Users › chi tiết: chỉ bot Market Making và Volume Farm có số này, hiện giống
// trang bot;
// chưa có khối lượng thì "Not available", không bao giờ 0. Chiến lược khác để trống.

type Bot = AdminUserDetail["bots"][number];

export function BotCostPerMillion({ bot }: { bot: Pick<Bot, "strategy" | "costPerMillion"> }) {
  const tm = useTranslations("common.missing");
  if (bot.strategy !== Strategy.volumeMaker && bot.strategy !== Strategy.volumeFarm) return null;
  return <>{bot.costPerMillion ?? tm("notAvailable")}</>;
}
