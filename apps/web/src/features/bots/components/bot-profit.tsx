"use client";

import type { BotSummary } from "@drift/shared";
import { PnLValue } from "@drift/ui";
import { useTranslations } from "next-intl";

import { useMarketNames } from "@/lib/markets";

// Profit của một bot (UI_REVIEW J1, quy tắc 1.8): chưa có lệnh khớp thì "No fills yet", có thì kèm đơn vị
// quote ("−0.03 USDC"). Spot dùng quote của market; perps và bot hai engine tính bằng USDC.
export function BotProfit({
  bot,
  className,
}: {
  bot: Pick<BotSummary, "netPnl" | "fills" | "market" | "engine">;
  className?: string;
}) {
  const tm = useTranslations("common.missing");
  const names = useMarketNames();
  if (bot.fills === 0)
    return <span className={`text-muted ${className ?? ""}`}>{tm("noFillsYet")}</span>;
  const quote = bot.engine === "spot" ? names.info(bot.market)?.quote : null;
  const unit = quote === null || quote === undefined ? "USDC" : names.asset(quote);
  return (
    <PnLValue
      value={bot.netPnl}
      locale="en-US"
      missingLabel={tm("notAvailable")}
      suffix={` ${unit}`}
      {...(className === undefined ? {} : { className })}
    />
  );
}
