import type { ResearchTrade } from "@drift/shared";
import type { useTranslations } from "next-intl";

import { pctSigned, usdCompact } from "./format";

// Câu chữ dựng từ một lệnh (dùng chung cho danh sách và hộp chi tiết).

export type Tr = ReturnType<typeof useTranslations<"signalAnalysis.research">>;

export function tradeTitle(x: ResearchTrade, t: Tr): string {
  const w = x.what;
  switch (w.type) {
    case "news":
      return w.headline;
    case "whales":
      return t("trades.what.whales", {
        tail: w.walletTail,
        side: x.side,
        size: usdCompact(w.sizeUsd),
      });
    case "funding":
      return t("trades.what.funding", {
        rate: pctSigned(w.ratePct),
        hours: w.perHours,
        top: String(w.topPct),
        days: w.days,
      });
    case "price":
      return t("trades.what.price", {
        mins: w.rangeMins,
        dir: w.direction,
        x: (Math.round(w.volumeVsUsual * 10) / 10).toString(),
      });
  }
}

export function sourcesText(n: number | null, top: number | null, t: Tr): string | null {
  if (n === null) return null;
  if (top !== null && top === n) return t("trades.sourcesTop", { n });
  if (top !== null && top > 0) return t("trades.sourcesMix", { n, top });
  return t("trades.sourcesN", { n });
}

export function skipText(x: ResearchTrade, t: Tr, short: boolean): string | null {
  const s = x.skipped;
  if (s === null) return null;
  if (s.reason === "tpUnderCost")
    return short || s.tpPct === null || s.neededPct === null
      ? t("trades.skip.tpUnderCostShort")
      : t("trades.skip.tpUnderCost", {
          tp: `${s.tpPct.toFixed(2)}%`,
          need: `${s.neededPct.toFixed(2)}%`,
        });
  if (s.reason === "alreadyOpen")
    return t("trades.skip.alreadyOpen", { type: t(`types.${x.type}`), asset: x.asset });
  return t("trades.skip.other", { reason: t(`reasons.${s.reason}`) });
}
