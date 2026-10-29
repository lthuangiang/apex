import { dec, DECIMAL_STRING_PATTERN, Decimal, feeRtPct, type Strategy } from "@drift/shared";
import { nextRun, REBALANCE_CHECK_MS, safetyOffsetPct } from "@drift/strategies";

import type { FormValues } from "./fields";

// Mô hình dữ liệu cho tab Preview của màn Create (artboard Create, UI_REVIEW B1). Hàm thuần: mọi số
// tính từ giá trị người dùng đã nhập, giá gần nhất của SoDEX (`last`) và đúng công thức engine dùng
// (packages/strategies). Thiếu dữ liệu thì trả `null` cho ô đó, không bao giờ đoán (quy tắc 1.8).

export interface Tile {
  /** Key câu chữ trong `createBot.preview.tiles`. */
  key: string;
  /** Tham số cho câu chữ; null = "Not available". */
  params: Record<string, string> | null;
}

export type PreviewModel =
  | {
      kind: "grid";
      lower: string;
      upper: string;
      levels: string[];
      stop: string | null;
      stopAbove: string | null;
      last: string | null;
      tiles: Tile[];
    }
  | {
      kind: "dca";
      direction: "long" | "short";
      rows: { index: number; size: string; offsetPct: string; price: string | null }[];
      takeProfitPct: string | null;
      tiles: Tile[];
    }
  | { kind: "schedule"; buys: { n: number; at: number }[]; total: number | null; tiles: Tile[] }
  | {
      kind: "weights";
      rows: { asset: string; weightPct: string; band: [string, string] | null }[];
      tiles: Tile[];
    }
  | {
      kind: "arb";
      half: string;
      qty: string | null;
      tiles: Tile[];
    }
  | { kind: "twap"; slices: number; tiles: Tile[] }
  | { kind: "tiles"; tiles: Tile[] };

/** Chuỗi số hợp lệ (bỏ dấu phẩy nghìn) → Decimal; còn lại → null. */
export function num(v: FormValues[string] | undefined): Decimal | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/,/g, "").trim();
  return DECIMAL_STRING_PATTERN.test(s) ? dec(s) : null;
}

const int = (v: FormValues[string] | undefined): number | null => {
  const d = num(v);
  return d !== null && d.isInteger() && d.gte(0) ? d.toNumber() : null;
};

/** Hiển thị: tối đa `dp` chữ số thập phân, bỏ số 0 thừa, có dấu phẩy nghìn. */
export function fmt(d: Decimal, dp = 4): string {
  const fixed = d.toDecimalPlaces(dp).toFixed();
  const [i = "0", f] = fixed.split(".");
  const sign = i.startsWith("-") ? "-" : "";
  const grouped = i.replace("-", "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}${grouped}${f === undefined ? "" : `.${f}`}`;
}

const pct = (d: Decimal, dp = 2) => fmt(d, dp);

/** Đơn vị quote/base của market SoDEX: `vBTC_vUSDC` → [vBTC, vUSDC]; `BTC-USD` (perps) → [BTC, USDC]. */
export function unitsOf(market: string): { base: string; quote: string } | null {
  if (market.includes("_")) {
    const [base = "", quote = ""] = market.split("_");
    return { base, quote };
  }
  if (market.includes("-")) return { base: market.split("-")[0] ?? "", quote: "USDC" };
  return null;
}

/**
 * Mức giá grid, cùng công thức với `gridPrices` của engine nhưng chưa làm tròn theo tick (Preview
 * không có quy tắc tick của market): arithmetic cách đều theo giá, geometric cách đều theo %.
 */
export function gridLevels(lower: Decimal, upper: Decimal, n: number, spacing: string): Decimal[] {
  const out: Decimal[] = [];
  for (let i = 0; i < n; i += 1) {
    const f = new Decimal(i).div(n - 1);
    out.push(
      spacing === "geometric"
        ? lower.mul(upper.div(lower).pow(f))
        : lower.add(upper.sub(lower).mul(f)),
    );
  }
  return out;
}

/** Bước nhỏ nhất giữa hai mức liền kề, theo % của mức thấp hơn (như `minStepFraction`). */
function minStepPct(levels: readonly Decimal[]): Decimal | null {
  let min: Decimal | null = null;
  for (let i = 1; i < levels.length; i += 1) {
    const a = levels[i - 1];
    const b = levels[i];
    if (a === undefined || b === undefined || !a.gt(0)) continue;
    const step = b.sub(a).div(a).mul(100);
    min = min === null ? step : Decimal.min(min, step);
  }
  return min;
}

const tile = (key: string, params: Record<string, string> | null): Tile => ({ key, params });

function gridModel(strategy: Strategy, v: FormValues, last: Decimal | null): PreviewModel | null {
  const lower = num(v.lowerPrice);
  const upper = num(v.upperPrice);
  const n = int(v.gridLevels);
  if (lower === null || upper === null || n === null || n < 2 || !lower.gt(0) || !upper.gt(lower))
    return null;
  const perps = strategy === "futures_grid";
  const levels = gridLevels(lower, upper, n, typeof v.spacing === "string" ? v.spacing : "");
  const market = typeof v.market === "string" ? v.market : "";
  const quote = unitsOf(market)?.quote ?? "";
  // Vốn danh nghĩa chia đều theo số mức (grid-bot: notional / levels); Perps: margin × leverage.
  const capital = perps ? num(v.margin) : num(v.investment);
  const leverage = perps ? num(v.leverage) : dec("1");
  const perLevel =
    capital === null || leverage === null ? null : capital.mul(leverage).div(levels.length);
  const step = minStepPct(levels);
  // Lệnh limit lúc start: mọi mức khác giá hiện tại (grid-bot `start`).
  const atStart = last === null ? levels.length : levels.filter((p) => !p.eq(last)).length;
  const stop = num(perps ? v.stopBelow : v.stopPrice);
  const stopAbove = perps ? num(v.stopAbove) : null;
  return {
    kind: "grid",
    lower: lower.toString(),
    upper: upper.toString(),
    levels: levels.map((l) => l.toString()),
    stop: stop?.toString() ?? null,
    stopAbove: stopAbove?.toString() ?? null,
    last: last?.toString() ?? null,
    tiles: [
      tile("perLevel", perLevel === null ? null : { value: fmt(perLevel, 2), unit: quote }),
      tile("step", step === null ? null : { value: pct(step) }),
      tile("ordersAtStart", { count: String(atStart) }),
      tile("roundTrip", { value: pct(feeRtPct(perps ? "perps" : "spot", null), 3) }),
    ],
  };
}

function dcaModel(strategy: Strategy, v: FormValues, last: Decimal | null): PreviewModel | null {
  const base = num(v.baseOrder);
  const safety = num(v.safetyOrder);
  const count = int(v.maxSafetyOrders);
  const first = num(v.firstStepPct);
  const stepMul = num(v.stepMultiplier);
  const sizeMul = num(v.sizeMultiplier);
  if (
    base === null ||
    safety === null ||
    count === null ||
    first === null ||
    stepMul === null ||
    sizeMul === null
  )
    return null;
  const perps = strategy === "futures_dca";
  const direction = perps && v.direction === "short" ? "short" : "long";
  const cfg = { firstStepPct: first.toString(), stepMultiplier: stepMul.toString() };
  const rows: { index: number; size: string; offsetPct: string; price: string | null }[] = [
    { index: 0, size: base.toString(), offsetPct: "0", price: last?.toString() ?? null },
  ];
  let total = base;
  for (let k = 1; k <= count; k += 1) {
    // Cỡ lệnh safety k = safety × sizeMultiplier^(k−1); độ lệch = safetyOffsetPct (engine).
    const size = safety.mul(sizeMul.pow(k - 1));
    const off = safetyOffsetPct(cfg, k);
    total = total.add(size);
    const price =
      last === null
        ? null
        : last.mul(direction === "long" ? dec("1").sub(off.div(100)) : dec("1").add(off.div(100)));
    rows.push({
      index: k,
      size: size.toString(),
      offsetPct: off.toString(),
      price: price?.toString() ?? null,
    });
  }
  const market = typeof v.market === "string" ? v.market : "";
  const quote = unitsOf(market)?.quote ?? "";
  const covers = rows.at(-1)?.offsetPct ?? "0";
  const tp = num(v.takeProfitPct);
  return {
    kind: "dca",
    direction,
    rows,
    takeProfitPct: tp?.toString() ?? null,
    tiles: [
      tile(perps ? "maxMargin" : "maxCapital", { value: fmt(total, 2), unit: quote }),
      tile(perps ? "coversMove" : "coversDrop", { value: pct(dec(covers)) }),
      tile("dcaOrdersAtStart", {}),
      tile("safetyOrders", { count: String(count) }),
    ],
  };
}

/** Số lần mua theo `ends`: hết budget = floor(budget / amount); N lần = N; never = vô hạn (null). */
function buyCount(v: FormValues): number | null {
  const amount = num(v.amountPerBuy);
  if (v.ends === "after_n_buys") return int(v.buyCount);
  if (v.ends === "after_budget") {
    const budget = num(v.totalBudget);
    return amount === null || budget === null || !amount.gt(0)
      ? null
      : budget.div(amount).floor().toNumber();
  }
  return null;
}

const SCHEDULE_SHOWN = 6;
const SCHEDULE_MAX = 500;

function scheduleModel(v: FormValues, now: number): PreviewModel | null {
  const amount = num(v.amountPerBuy);
  const time = typeof v.time === "string" ? v.time.trim() : "";
  const tz = typeof v.timeZone === "string" ? v.timeZone : "UTC";
  const frequency = v.frequency;
  if (
    amount === null ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) ||
    (frequency !== "daily" && frequency !== "weekly" && frequency !== "monthly")
  )
    return null;
  const total = buyCount(v);
  const market = typeof v.market === "string" ? v.market : "";
  const quote = unitsOf(market)?.quote ?? "";
  // Lịch giống engine: `nextRun` theo múi giờ của người dùng (mặc định weekly: thứ Hai, monthly: ngày 1).
  const sched = {
    frequency,
    time,
    timeZone: tz,
    dayOfWeek: frequency === "weekly" ? (int(v.dayOfWeek) ?? undefined) : undefined,
    dayOfMonth: frequency === "monthly" ? (int(v.dayOfMonth) ?? undefined) : undefined,
  } as const;
  const shown = total === null ? SCHEDULE_SHOWN : Math.min(total, SCHEDULE_SHOWN);
  const buys: { n: number; at: number }[] = [];
  let at = now;
  let lastAt: number | null = null;
  const until = total === null ? shown : Math.min(total, SCHEDULE_MAX);
  for (let i = 1; i <= until; i += 1) {
    at = nextRun(sched, at);
    if (i <= shown) buys.push({ n: i, at });
    lastAt = at;
  }
  return {
    kind: "schedule",
    buys,
    total,
    tiles: [
      tile(
        "buys",
        total === null ? null : { count: String(total), amount: fmt(amount, 2), unit: quote },
      ),
      tile("nextBuy", buys[0] === undefined ? null : { at: String(buys[0].at) }),
      tile(
        "ends",
        total === null || total > SCHEDULE_MAX || lastAt === null ? null : { at: String(lastAt) },
      ),
      tile("builderFee", {}),
    ],
  };
}

function weightsModel(v: FormValues): PreviewModel | null {
  const assets = Array.isArray(v.assets) ? v.assets : [];
  const rows = assets
    .map((a) => ({ asset: a.asset.trim(), w: num(a.weightPct) }))
    .filter((a): a is { asset: string; w: Decimal } => a.asset !== "" && a.w?.gt(0) === true);
  if (rows.length === 0) return null;
  const threshold = v.rebalanceWhen === "threshold" ? num(v.thresholdPct) : null;
  return {
    kind: "weights",
    rows: rows.map((r) => ({
      asset: r.asset,
      weightPct: r.w.toString(),
      // Dải không rebalance: mục tiêu ± ngưỡng (điểm %).
      band:
        threshold === null
          ? null
          : [Decimal.max(r.w.sub(threshold), 0).toString(), r.w.add(threshold).toString()],
    })),
    tiles: [
      tile("assets", { count: String(rows.length) }),
      tile("checks", { minutes: String(REBALANCE_CHECK_MS / 60_000) }),
      tile("threshold", threshold === null ? null : { value: pct(threshold) }),
    ],
  };
}

function arbModel(v: FormValues, last: Decimal | null): PreviewModel | null {
  const investment = num(v.investment);
  if (!investment?.gt(0)) return null;
  // funding-arb: một nửa vốn cho chân spot, một nửa làm margin chân perp; khối lượng = nửa vốn / giá.
  const half = investment.div(2);
  const qty = !last?.gt(0) ? null : half.div(last);
  const asset = typeof v.asset === "string" ? v.asset : "";
  return {
    kind: "arb",
    half: half.toString(),
    qty: qty?.toString() ?? null,
    tiles: [
      tile("spotLeg", qty === null ? null : { qty: fmt(qty, 6), asset }),
      tile("perpLeg", qty === null ? null : { qty: fmt(qty, 6), asset }),
      tile("netExposure", {}),
    ],
  };
}

function twapModel(v: FormValues): PreviewModel | null {
  const total = num(v.totalSize);
  const slices = int(v.slices);
  const minutes = int(v.durationMinutes);
  if (total === null || slices === null || minutes === null || slices < 1) return null;
  const market = typeof v.market === "string" ? v.market : "";
  const base = unitsOf(market)?.base ?? "";
  // Như `sliceIntervalMs` của engine: floor(thời lượng / số lát).
  const everyMs = Math.floor((minutes * 60_000) / slices);
  return {
    kind: "twap",
    slices,
    tiles: [
      tile("slice", { value: fmt(total.div(slices), 6), unit: base }),
      tile("interval", { seconds: String(Math.round(everyMs / 1000)) }),
      tile("orderType", {}),
    ],
  };
}

/** null = chưa đủ dữ liệu để vẽ: tab Preview giữ khung và hiện trạng thái trống. */
export function previewModel(
  strategy: Strategy,
  values: FormValues,
  last: string | null,
  now: number,
): PreviewModel | null {
  const p = last === null ? null : num(last);
  switch (strategy) {
    case "spot_grid":
    case "futures_grid":
      return gridModel(strategy, values, p);
    case "spot_dca":
    case "futures_dca":
      return dcaModel(strategy, values, p);
    case "recurring_buy":
      return scheduleModel(values, now);
    case "rebalancing":
      return weightsModel(values);
    case "funding_arb":
      return arbModel(values, p);
    case "twap":
      return twapModel(values);
    case "volume_maker":
      return null;
  }
}

/** Market dùng để đọc giá gần nhất cho Preview. */
export function priceMarketOf(strategy: Strategy, values: FormValues): string | null {
  const m = strategy === "funding_arb" ? values.spotMarket : values.market;
  return typeof m === "string" && m !== "" ? m : null;
}

export interface LiveHint {
  /** Key câu chữ trong `createBot.preview.hints`. */
  key: string;
  params: Record<string, string>;
}

/**
 * Gợi ý động dưới ô của grid (artboard Create): giá biên so với giá gần nhất, và bước giữa các mức.
 * Field không có trong kết quả thì giữ gợi ý tĩnh.
 */
export function liveHints(
  strategy: Strategy,
  v: FormValues,
  last: string | null,
): Record<string, LiveHint> {
  if (strategy === "twap") {
    // Duration nhập bằng phút; từ 60 phút hiện bản quy đổi "= 4 h" (UI_REVIEW G4).
    const d = int(v.durationMinutes);
    if (d === null || d < 60) return {};
    const h = Math.floor(d / 60);
    const m = d % 60;
    return {
      durationMinutes:
        m === 0
          ? { key: "durationHours", params: { h: String(h) } }
          : { key: "durationHoursMinutes", params: { h: String(h), m: String(m) } },
    };
  }
  if (strategy === "futures_dca") {
    // Hint Direction theo artboard Create-FDCA ("Long adds on drops").
    return {
      direction: { key: v.direction === "short" ? "fdcaShort" : "fdcaLong", params: {} },
    };
  }
  if (strategy !== "spot_grid" && strategy !== "futures_grid") return {};
  const out: Record<string, LiveHint> = {};
  const p = last === null ? null : num(last);
  if (p?.gt(0) === true) {
    for (const key of ["lowerPrice", "upperPrice"]) {
      const x = num(v[key]);
      if (x === null || x.eq(p)) continue;
      const diff = x.sub(p).abs().div(p).mul(100);
      out[key] = {
        key: x.lt(p) ? "belowLast" : "aboveLast",
        params: { pct: pct(diff, 1) },
      };
    }
  }
  const lower = num(v.lowerPrice);
  const upper = num(v.upperPrice);
  const n = int(v.gridLevels);
  if (lower !== null && upper !== null && n !== null && n >= 2 && lower.gt(0) && upper.gt(lower)) {
    const step = minStepPct(
      gridLevels(lower, upper, n, typeof v.spacing === "string" ? v.spacing : ""),
    );
    if (step !== null)
      out.gridLevels =
        v.spacing === "geometric"
          ? { key: "levelsGeometric", params: { pct: pct(step, 2) } }
          : {
              key: "levelsArithmetic",
              params: {
                // Bước ≥ 1: 2 chữ số lẻ; nhỏ hơn: 8 chữ số có nghĩa (giá kiểu 0.0070).
                step: (() => {
                  const raw = upper.sub(lower).div(n - 1);
                  return raw.gte(1) ? fmt(raw, 2) : fmt(raw.toSignificantDigits(8), 8);
                })(),
                pct: pct(step, 2),
              },
            };
  }
  return out;
}

/** Giá hiển thị: ≥ 1000 lấy 2 chữ số lẻ; nhỏ hơn giữ 6 chữ số có nghĩa (giá kiểu 0.3528 không bị cắt). */
export function fmtPrice(s: string): string {
  const d = num(s);
  if (d === null) return s;
  return d.abs().gte(1000) ? fmt(d, 2) : fmt(d.toSignificantDigits(6), 10);
}
