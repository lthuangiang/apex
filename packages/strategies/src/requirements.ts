import { dec, Decimal, mul, Strategy, sum } from "@drift/shared";

import { safetyOffsetPct } from "./common/dca-bot";
import { gridPrices } from "./common/grid";
import { meetsMinimum, roundQty } from "./core/rounding";
import type { MarketRules } from "./core/types";
import { VM_DEFAULTS } from "./volume-maker/schema";

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
/**
 * Lệnh mở của Copy Trade: `fixed` = fixedNotional; `ratio` phụ thuộc cỡ lệnh của leader nên chỉ kiểm tra được trần
 * mỗi lệnh (lệnh nhỏ hơn mức tối thiểu lúc chạy thì bot bỏ qua và ghi log).
 */
const copyOrder = (c: Cfg) =>
  c.sizing === "ratio" ? s(c, "maxNotionalPerTrade") : s(c, "fixedNotional");

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
    case Strategy.volumeMaker: {
      // Margin của vị thế lớn nhất (DEC-99): max open position / đòn bẩy; thiếu thì 2 × order size (DEC-100), 5×.
      const inv =
        c.maxInventory !== undefined && c.maxInventory !== ""
          ? dec(s(c, "maxInventory"))
          : dec(s(c, "orderSize")).mul(
              typeof c.maxOrders === "number" ? c.maxOrders : VM_DEFAULTS.maxInventoryMultiple,
            );
      return {
        market: s(c, "market"),
        engine: "perps",
        capital: inv
          .div(n(c, "leverage") || VM_DEFAULTS.leverage)
          .toDecimalPlaces(2, Decimal.ROUND_UP)
          .toString(),
      };
    }
    case Strategy.adaptiveDca:
      // Margin của vị thế lớn nhất được phép: maxExposure / đòn bẩy (DEC-107).
      return {
        market: s(c, "market"),
        engine: "perps",
        capital: dec(s(c, "maxExposure"))
          .div(n(c, "leverage") || 1)
          .toDecimalPlaces(2, Decimal.ROUND_UP)
          .toString(),
      };
    case Strategy.copyTrade:
      // Margin của tổng vị thế được phép: maxExposure / đòn bẩy (DEC-161). Nhiều market (DEC-163): `bots.market` lưu
      // market đầu, như Rebalancing. Đòn bẩy theo market (DEC-226): lấy đòn bẩy thấp nhất (= budget).
      return {
        market: copyMarkets(c)[0] ?? "",
        engine: "perps",
        capital: dec(s(c, "maxExposure"))
          .div(copyLowestLeverage(c) || 1)
          .toDecimalPlaces(2, Decimal.ROUND_UP)
          .toString(),
      };
    case Strategy.volumeFarm:
      // Margin của lệnh lớn nhất: notional / đòn bẩy.
      return {
        market: s(c, "market"),
        engine: "perps",
        capital: dec(s(c, "orderSizeMaxUsd"))
          .div(n(c, "leverage") || 1)
          .toDecimalPlaces(2, Decimal.ROUND_UP)
          .toString(),
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
    case Strategy.volumeFarm:
      return meetsMinimum(price, roundQty(dec(s(c, "orderSizeMinUsd")).div(price), rules), rules);
    case Strategy.adaptiveDca: {
      const small = Decimal.min(dec(s(c, "baseOrder")), dec(s(c, "safetyOrder")));
      return meetsMinimum(price, roundQty(small.div(price), rules), rules);
    }
    case Strategy.copyTrade:
      return meetsMinimum(price, roundQty(dec(copyOrder(c)).div(price), rules), rules);
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
  [Strategy.volumeFarm]: "orderSizeMinUsd",
  [Strategy.adaptiveDca]: "baseOrder",
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
    case Strategy.volumeFarm:
      return [
        { price: dec(price), qty: dec(roundQty(dec(s(c, "orderSizeMinUsd")).div(price), rules)) },
      ];
    case Strategy.adaptiveDca:
      return [
        { price: dec(price), qty: dec(roundQty(dec(s(c, "baseOrder")).div(price), rules)) },
        { price: dec(price), qty: dec(roundQty(dec(s(c, "safetyOrder")).div(price), rules)) },
      ];
    case Strategy.copyTrade:
      return [{ price: dec(price), qty: dec(roundQty(dec(copyOrder(c)).div(price), rules)) }];
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

/** Đòn bẩy thấp nhất của bot copy trên các market của nó (`leverageByMarket`, thiếu thì `leverage`). 0 = không có. */
export function copyLowestLeverage(c: Readonly<Record<string, unknown>>): number {
  const base = typeof c.leverage === "number" ? c.leverage : 0;
  const per =
    typeof c.leverageByMarket === "object" && c.leverageByMarket !== null
      ? (c.leverageByMarket as Record<string, unknown>)
      : {};
  const levs = copyMarkets(c).map((m) => {
    const l = per[m];
    return typeof l === "number" ? l : base;
  });
  return levs.length === 0 ? base : Math.min(...levs);
}

/** Market của bot copy: `markets` (DEC-163), hoặc `market` của config cũ. */
export function copyMarkets(c: Readonly<Record<string, unknown>>): string[] {
  if (Array.isArray(c.markets)) return c.markets.filter((m): m is string => typeof m === "string");
  return typeof c.market === "string" ? [c.market] : [];
}

/**
 * Vốn của bot theo cấu hình (cột Capital ở Strategy Lab; tin "Bot started" gửi team, DEC-191). TWAP
 * không có vốn quote cố định: trả tổng khối lượng (`totalSize`, đơn vị base, UI_REVIEW N2). Không tính được → null.
 */
export function botCapitalOf(
  strategy: string,
  config: unknown,
): { capital: string | null; capitalUnit: "quote" | "base" } {
  if (config === null || typeof config !== "object") return { capital: null, capitalUnit: "quote" };
  const c = config as Cfg;
  try {
    if (strategy === Strategy.twap) {
      const size = typeof c.totalSize === "string" ? c.totalSize : null;
      return { capital: size !== null && dec(size).gt(0) ? size : null, capitalUnit: "base" };
    }
    const capital = requirementOf(strategy, c).capital;
    return { capital: dec(capital).gt(0) ? capital : null, capitalUnit: "quote" };
  } catch {
    return { capital: null, capitalUnit: "quote" };
  }
}
