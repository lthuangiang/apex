import { dec, Decimal, mul, Strategy, sum } from "@drift/shared";

import { safetyOffsetPct } from "./common/dca-bot";
import { gridPrices } from "./common/grid";
import { meetsMinimum, roundQty } from "./core/rounding";
import type { MarketRules } from "./core/types";

// Yêu cầu trước khi start (SCREENS.md mục 8.2 "Before it starts"): vốn cần và kiểm tra min size SAU khi
// làm tròn. Hàm thuần; api gọi với market info và giá hiện tại.

export interface Requirement {
  /** Market chính để đọc giá / quy tắc. */
  market: string;
  engine: "spot" | "perps" | "spot+perps";
  /** Vốn (quote) bot sẽ dùng: investment, margin, hoặc tổng tối đa của DCA. */
  capital: string;
}

type Cfg = Record<string, unknown>;
const s = (c: Cfg, k: string) => {
  const v = c[k];
  return typeof v === "string" || typeof v === "number" ? String(v) : "0";
};
const n = (c: Cfg, k: string) => Number(c[k] ?? 0);

export function requirementOf(strategy: string, c: Cfg): Requirement {
  switch (strategy) {
    case Strategy.spotGrid:
      return { market: s(c, "market"), engine: "spot", capital: s(c, "investment") };
    case Strategy.futuresGrid:
      return { market: s(c, "market"), engine: "perps", capital: s(c, "margin") };
    case Strategy.spotDca:
    case Strategy.futuresDca: {
      let total = dec(s(c, "baseOrder"));
      for (let k = 1; k <= n(c, "maxSafetyOrders"); k += 1)
        total = total.add(dec(s(c, "safetyOrder")).mul(dec(s(c, "sizeMultiplier")).pow(k - 1)));
      return {
        market: s(c, "market"),
        engine: strategy === Strategy.spotDca ? "spot" : "perps",
        capital: total.toString(),
      };
    }
    case Strategy.recurringBuy:
      return { market: s(c, "market"), engine: "spot", capital: s(c, "amountPerBuy") };
    case Strategy.rebalancing: {
      const first =
        (c.assets as { market?: string }[] | undefined)?.find((a) => a.market !== undefined)
          ?.market ?? "";
      return { market: first, engine: "spot", capital: s(c, "investment") };
    }
    case Strategy.fundingArb:
      return { market: s(c, "perpMarket"), engine: "spot+perps", capital: s(c, "investment") };
    case Strategy.twap:
      return {
        market: s(c, "market"),
        engine: c.engine === "perps" ? "perps" : "spot",
        capital: "0",
      };
    default:
      return { market: s(c, "market"), engine: "spot", capital: "0" };
  }
}

/** Mọi lệnh đầu tiên ≥ min size của SoDEX sau khi làm tròn theo tick/lot. */
export function meetsMinSize(strategy: string, c: Cfg, rules: MarketRules, price: string): boolean {
  switch (strategy) {
    case Strategy.spotGrid:
    case Strategy.futuresGrid: {
      const levels = gridPrices(
        s(c, "lowerPrice"),
        s(c, "upperPrice"),
        n(c, "gridLevels"),
        c.spacing === "geometric" ? "geometric" : "arithmetic",
        rules,
      );
      const notional =
        strategy === Strategy.futuresGrid
          ? mul(s(c, "margin"), String(n(c, "leverage") || 1))
          : dec(s(c, "investment"));
      const qty = roundQty(notional.div(levels.length).div(sum(levels).div(levels.length)), rules);
      return levels.every((p) => meetsMinimum(p, qty, rules));
    }
    case Strategy.spotDca:
    case Strategy.futuresDca: {
      const lev = strategy === Strategy.futuresDca ? n(c, "leverage") || 1 : 1;
      const baseQty = roundQty(mul(s(c, "baseOrder"), String(lev)).div(price), rules);
      if (!meetsMinimum(price, baseQty, rules)) return false;
      if (n(c, "maxSafetyOrders") === 0) return true;
      const drop = safetyOffsetPct(
        { firstStepPct: s(c, "firstStepPct"), stepMultiplier: s(c, "stepMultiplier") },
        1,
      ).div(100);
      const p1 = dec(price).mul(new Decimal(1).sub(drop));
      return meetsMinimum(
        p1,
        roundQty(mul(s(c, "safetyOrder"), String(lev)).div(p1), rules),
        rules,
      );
    }
    case Strategy.recurringBuy:
      return meetsMinimum(price, roundQty(dec(s(c, "amountPerBuy")).div(price), rules), rules);
    case Strategy.twap:
      return meetsMinimum(
        price,
        roundQty(dec(s(c, "totalSize")).div(n(c, "slices") || 1), rules),
        rules,
      );
    case Strategy.fundingArb:
      return meetsMinimum(price, roundQty(dec(s(c, "investment")).div(2).div(price), rules), rules);
    case Strategy.rebalancing:
      return dec(s(c, "investment")).gte(rules.minNotional);
    case Strategy.volumeMaker:
      return meetsMinimum(price, roundQty(dec(s(c, "orderSize")).div(price), rules), rules);
    default:
      return false;
  }
}

/** Field vốn chính của từng chiến lược: dùng để đề xuất vốn tối thiểu (UI_REVIEW H2). DCA có hai field → null. */
const CAPITAL_FIELD: Partial<Record<string, string>> = {
  [Strategy.spotGrid]: "investment",
  [Strategy.futuresGrid]: "margin",
  [Strategy.recurringBuy]: "amountPerBuy",
  [Strategy.twap]: "totalSize",
  [Strategy.fundingArb]: "investment",
  [Strategy.rebalancing]: "investment",
  [Strategy.volumeMaker]: "orderSize",
};

export interface MinSizeDetail {
  /** Notional (quote) của lệnh nhỏ nhất sau khi làm tròn theo lot; null khi không tính được. */
  smallest: string | null;
  /** Mức tối thiểu của SoDEX cho lệnh đó: max(minNotional, minQuantity × giá). */
  required: string;
  /** Field vốn chính và giá trị nhỏ nhất (làm tròn lên 0.01) để mọi lệnh đạt mức tối thiểu; null khi không có. */
  capitalField: string | null;
  suggestedCapital: string | null;
}

/** Các lệnh (giá, khối lượng sau làm tròn) mà kiểm tra min size xét, theo cùng công thức `meetsMinSize`. */
function sizedOrders(
  strategy: string,
  c: Cfg,
  rules: MarketRules,
  price: string,
): { price: Decimal; qty: Decimal }[] {
  switch (strategy) {
    case Strategy.spotGrid:
    case Strategy.futuresGrid: {
      const levels = gridPrices(
        s(c, "lowerPrice"),
        s(c, "upperPrice"),
        n(c, "gridLevels"),
        c.spacing === "geometric" ? "geometric" : "arithmetic",
        rules,
      );
      const notional =
        strategy === Strategy.futuresGrid
          ? mul(s(c, "margin"), String(n(c, "leverage") || 1))
          : dec(s(c, "investment"));
      const qty = dec(
        roundQty(notional.div(levels.length).div(sum(levels).div(levels.length)), rules),
      );
      return levels.map((p) => ({ price: dec(p), qty }));
    }
    case Strategy.spotDca:
    case Strategy.futuresDca: {
      const lev = strategy === Strategy.futuresDca ? n(c, "leverage") || 1 : 1;
      const out = [
        {
          price: dec(price),
          qty: dec(roundQty(mul(s(c, "baseOrder"), String(lev)).div(price), rules)),
        },
      ];
      if (n(c, "maxSafetyOrders") > 0) {
        const drop = safetyOffsetPct(
          { firstStepPct: s(c, "firstStepPct"), stepMultiplier: s(c, "stepMultiplier") },
          1,
        ).div(100);
        const p1 = dec(price).mul(new Decimal(1).sub(drop));
        out.push({
          price: p1,
          qty: dec(roundQty(mul(s(c, "safetyOrder"), String(lev)).div(p1), rules)),
        });
      }
      return out;
    }
    case Strategy.recurringBuy:
      return [
        { price: dec(price), qty: dec(roundQty(dec(s(c, "amountPerBuy")).div(price), rules)) },
      ];
    case Strategy.twap:
      return [
        {
          price: dec(price),
          qty: dec(roundQty(dec(s(c, "totalSize")).div(n(c, "slices") || 1), rules)),
        },
      ];
    case Strategy.fundingArb:
      return [
        { price: dec(price), qty: dec(roundQty(dec(s(c, "investment")).div(2).div(price), rules)) },
      ];
    case Strategy.volumeMaker:
      return [{ price: dec(price), qty: dec(roundQty(dec(s(c, "orderSize")).div(price), rules)) }];
    default:
      return [];
  }
}

/**
 * Chi tiết check min size (UI_REVIEW H2): lệnh nhỏ nhất sau làm tròn, mức tối thiểu SoDEX, và vốn tối thiểu
 * đề xuất = giá trị nhỏ nhất của field vốn chính (giữ nguyên mọi tham số khác) để `meetsMinSize` đạt. Tìm
 * nhị phân tất định trên chính hàm kiểm tra, không ước lượng.
 */
export function minSizeDetail(
  strategy: string,
  c: Cfg,
  rules: MarketRules,
  price: string,
): MinSizeDetail {
  let smallest: { price: Decimal; qty: Decimal } | undefined;
  try {
    for (const o of sizedOrders(strategy, c, rules, price)) {
      if (smallest === undefined || o.price.mul(o.qty).lt(smallest.price.mul(smallest.qty)))
        smallest = o;
    }
  } catch {
    smallest = undefined;
  }
  const at = smallest?.price ?? dec(price);
  const required = Decimal.max(dec(rules.minNotional), dec(rules.minQuantity).mul(at));
  const field =
    strategy === Strategy.rebalancing ? "investment" : (CAPITAL_FIELD[strategy] ?? null);
  let suggested: string | null = null;
  if (field !== null) {
    const ok = (v: Decimal) => {
      try {
        return meetsMinSize(strategy, { ...c, [field]: v.toFixed(2) }, rules, price);
      } catch {
        return false;
      }
    };
    let lo = new Decimal(0);
    let hi = Decimal.max(dec(s(c, field)), new Decimal(1));
    for (let i = 0; i < 40 && !ok(hi); i += 1) {
      lo = hi;
      hi = hi.mul(2);
    }
    if (ok(hi)) {
      for (let i = 0; i < 60 && hi.sub(lo).gt("0.01"); i += 1) {
        const mid = lo.add(hi).div(2);
        if (ok(mid)) hi = mid;
        else lo = mid;
      }
      const up = hi.toDecimalPlaces(2, Decimal.ROUND_UP);
      suggested = ok(up) ? up.toFixed(2) : null;
    }
  }
  return {
    smallest:
      smallest === undefined
        ? null
        : smallest.price.mul(smallest.qty).toDecimalPlaces(2).toString(),
    required: required.toDecimalPlaces(2, Decimal.ROUND_UP).toString(),
    capitalField: field,
    suggestedCapital: suggested,
  };
}
