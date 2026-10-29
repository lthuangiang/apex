import { Decimal } from "@drift/shared";

import type { FormValues } from "./fields";

// Tổng vốn của bot theo các ô đang nhập trên form, cùng nghĩa với `capital` của engine đề xuất
// (packages/shared/src/reco/params.ts). Dùng khi người dùng chưa lưu vốn ở onboarding bước 5.
// Thiếu hoặc không hợp lệ → undefined (api dùng vốn trong goals nếu có).

function positive(v: FormValues[string] | undefined): Decimal | undefined {
  if (typeof v !== "string" || v.trim() === "") return undefined;
  try {
    const d = new Decimal(v.trim());
    return d.isFinite() && d.gt(0) ? d : undefined;
  } catch {
    return undefined;
  }
}

export function capitalOf(strategy: string, values: FormValues): string | undefined {
  let total: Decimal | undefined;
  switch (strategy) {
    case "futures_grid":
      total = positive(values.margin);
      break;
    case "spot_dca":
    case "futures_dca": {
      const base = positive(values.baseOrder);
      if (base === undefined) break;
      total = base;
      const safety = positive(values.safetyOrder);
      const mult = positive(values.sizeMultiplier) ?? new Decimal(1);
      const n = Number(values.maxSafetyOrders);
      if (safety !== undefined && Number.isInteger(n) && n > 0) {
        for (let k = 1; k <= n; k += 1) total = total.add(safety.mul(mult.pow(k - 1)));
      }
      break;
    }
    case "recurring_buy": {
      const amount = positive(values.amountPerBuy);
      const count = positive(values.buyCount);
      total = amount !== undefined && count !== undefined ? amount.mul(count) : undefined;
      break;
    }
    default:
      total = positive(values.investment);
  }
  return total?.toString();
}
