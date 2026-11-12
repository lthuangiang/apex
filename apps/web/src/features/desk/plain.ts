import { assetOf, dec } from "@drift/shared";

// "What the bot will do" (AI_DESK_RECOMMENDED.md mục 6): tham số của đề xuất → giá trị cho câu thường trong messages
// (`desk.will.<strategy>`). Chỉ đọc đúng giá trị đã lưu, không tính lại; thiếu giá trị thì không có câu.

type Values = Readonly<Record<string, unknown>>;
const str = (v: unknown): string | null =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : null;
const num = (v: string | null) => {
  if (v === null) return null;
  try {
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 }).format(Number(dec(v)));
  } catch {
    return null;
  }
};

export function willParams(
  strategy: string,
  values: Values,
  capital: string,
): Record<string, string> | null {
  const v = (k: string) => num(str(values[k]));
  const market = str(values.market) ?? str(values.perpMarket) ?? "";
  const need = (o: Record<string, string | null>) =>
    Object.values(o).every((x) => x !== null) ? (o as Record<string, string>) : null;
  switch (strategy) {
    case "spot_grid":
      return need({
        capital: num(capital),
        lower: v("lowerPrice"),
        upper: v("upperPrice"),
        stop: v("stopPrice"),
        maxLoss: v("maxLoss"),
      });
    case "futures_grid":
      return need({
        capital: num(capital),
        leverage: str(values.leverage),
        market,
        lower: v("lowerPrice"),
        upper: v("upperPrice"),
        stop: v("stopBelow"),
        maxLoss: v("maxLoss"),
      });
    case "spot_dca":
      return need({
        base: v("baseOrder"),
        market,
        count: str(values.maxSafetyOrders),
        safety: v("safetyOrder"),
        tp: v("takeProfitPct"),
        maxLoss: v("maxLoss"),
      });
    case "futures_dca":
      return need({
        leverage: str(values.leverage),
        market,
        base: v("baseOrder"),
        count: str(values.maxSafetyOrders),
        safety: v("safetyOrder"),
        tp: v("takeProfitPct"),
        sl: v("stopLossPct"),
        maxLoss: v("maxLoss"),
      });
    case "recurring_buy":
      return need({ amount: v("amountPerBuy"), market, count: str(values.buyCount) });
    case "rebalancing": {
      const assets = Array.isArray(values.assets)
        ? (values.assets as { asset?: unknown; weightPct?: unknown }[])
        : [];
      const weights = assets
        .map((a) => `${str(a.asset) ?? "?"} ${str(a.weightPct) ?? "?"}%`)
        .join(", ");
      return need({
        capital: num(capital),
        weights: weights === "" ? null : weights,
        threshold: v("thresholdPct"),
      });
    }
    case "funding_arb":
      return need({
        capital: num(capital),
        asset: str(values.asset) ?? assetOf(market),
        enter: v("enterFundingPct"),
        maxLoss: v("maxLoss"),
      });
    default:
      return null;
  }
}
