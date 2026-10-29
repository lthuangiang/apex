"use client";

import { Decimal } from "@drift/shared";
import { useTranslations } from "next-intl";

import { usePortfolio } from "@/features/account/components/portfolio-page";
import { formatAmount } from "@/lib/format";
import { useMarketNames } from "@/lib/markets";

import { capitalOf } from "../capital";
import type { FormValues } from "../fields";
import { unitsOf } from "../preview";

// Dòng thông tin dưới nhóm Amount (UI_REVIEW G2): số dư khả dụng lấy từ /api/v1/portfolio, vốn tối đa
// của DCA (cùng công thức `capitalOf`), quy mô vị thế Perps và cách chia vốn của Funding Arb. Thiếu dữ
// liệu thì "Not available", không hiện 0.

function positive(v: FormValues[string] | undefined): Decimal | undefined {
  if (typeof v !== "string" || v.trim() === "") return undefined;
  try {
    const d = new Decimal(v.trim());
    return d.isFinite() && d.gt(0) ? d : undefined;
  } catch {
    return undefined;
  }
}

const fmt = (v: Decimal | string) => formatAmount(v.toString(), null)?.text ?? v.toString();

export function AmountLines({ strategy, values }: { strategy: string; values: FormValues }) {
  const t = useTranslations("createBot.amountLines");
  const names = useMarketNames();
  const portfolio = usePortfolio();
  const pf = portfolio.data?.portfolio ?? null;
  const lines: string[] = [];

  const str = (k: string) => (typeof values[k] === "string" ? values[k] : "");
  const spotUnits = unitsOf(str("market"));

  // Số dư Spot theo tên hiển thị của tài sản (USDC, BTC…); không có coin đó → "No X on Spot".
  const spotLine = (asset: string) => {
    if (pf === null) return t("unavailable");
    const h = pf.holdings.find((x) => names.asset(x.coin) === asset);
    return h === undefined
      ? t("noneSpot", { asset })
      : t("availableSpot", { amount: fmt(h.available), asset });
  };
  const perpsLine = () =>
    pf?.accounts.perps === null || pf === null
      ? t("unavailable")
      : t("availablePerps", { amount: fmt(pf.accounts.perps.availableMargin) });

  switch (strategy) {
    case "spot_grid":
    case "spot_dca":
    case "recurring_buy":
      if (spotUnits !== null) lines.push(spotLine(names.asset(spotUnits.quote)));
      if (strategy === "spot_dca") {
        const c = capitalOf(strategy, values);
        if (c !== undefined && spotUnits !== null)
          lines.push(t("maxCapital", { amount: fmt(c), asset: names.asset(spotUnits.quote) }));
      }
      break;
    case "rebalancing": {
      const q = str("quoteAsset");
      if (q !== "") lines.push(spotLine(q));
      break;
    }
    case "futures_grid":
    case "futures_dca": {
      lines.push(perpsLine());
      if (strategy === "futures_dca") {
        const c = capitalOf(strategy, values);
        if (c !== undefined) lines.push(t("maxMargin", { amount: fmt(c) }));
      }
      const margin =
        strategy === "futures_grid"
          ? positive(values.margin)
          : positive(capitalOf(strategy, values));
      const lev = positive(values.leverage);
      if (margin !== undefined && lev !== undefined)
        lines.push(t("position", { amount: fmt(margin.mul(lev)) }));
      break;
    }
    case "funding_arb": {
      const inv = positive(values.investment);
      const spot = unitsOf(str("spotMarket"));
      const asset = spot === null ? "USDC" : names.asset(spot.quote);
      if (inv !== undefined) lines.push(t("split", { amount: fmt(inv.div(2)), asset }));
      lines.push(spotLine(asset), perpsLine());
      break;
    }
    case "twap": {
      if (values.engine === "perps") lines.push(perpsLine());
      else if (spotUnits !== null)
        lines.push(
          spotLine(names.asset(values.side === "sell" ? spotUnits.base : spotUnits.quote)),
        );
      break;
    }
    default:
      break;
  }
  if (lines.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs text-ink-2" aria-live="polite">
      {lines.map((l) => (
        <li key={l}>{l}</li>
      ))}
    </ul>
  );
}
