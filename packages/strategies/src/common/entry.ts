import { dec, gte, lte } from "@drift/shared";
import { z } from "zod";

import { optionalPositive, percent } from "./schema";

// Điều kiện vào lệnh dùng chung (IMPROVEMENTS IMP-01, IMP-02; DEC-91) cho Spot/Futures DCA và Spot/Futures Grid.
// Config giữ dạng phẳng như form (`entry`, `entryPrice`, `entryLow`, `entryHigh`); lõi bot dùng dạng chuẩn hoá
// `EntryCondition`. Hàm thuần, không I/O, nên engine và backtest dùng chung.

export const entryFields = {
  entry: z.enum(["now", "at_price", "in_range"]).optional(),
  entryPrice: optionalPositive(),
  entryLow: optionalPositive(),
  entryHigh: optionalPositive(),
};

export const nextCycleFields = {
  nextCycle: z.enum(["immediately", "after_pullback", "cooldown", "same_as_entry"]).optional(),
  pullbackPct: percent(0.1, 50, "Allowed 0.1–50%.").optional(),
  cooldownMinutes: z
    .number()
    .int()
    .min(1, { message: "Allowed 1–10080 minutes." })
    .max(10080, { message: "Allowed 1–10080 minutes." })
    .optional(),
};

export type EntryCondition =
  | { type: "now" }
  /** Long: giá ≤ P. Short: giá ≥ P. Neutral: giá cắt qua P. */
  | { type: "at_price"; price: string }
  /** Cắt qua P (giá trước và giá sau nằm hai phía, hoặc chạm). `triggerPrice` cũ của Grid. */
  | { type: "cross"; price: string }
  /** Long: giá ≤ H. Short: giá ≥ L. Neutral: L ≤ giá ≤ H. */
  | { type: "in_range"; low: string; high: string }
  /**
   * L ≤ giá ≤ H ở mọi hướng. Spot Grid mặc định chờ giá vào khoảng lưới thay vì mua market khi giá đang ngoài khoảng
   * (PM chốt sau bản rà soát strategy). UI hiện như `in_range`.
   */
  | { type: "within"; low: string; high: string };

export type NextCycle =
  | { type: "immediately" }
  | { type: "after_pullback"; pct: string }
  | { type: "cooldown"; minutes: number }
  | { type: "same_as_entry" };

export type EntryDirection = "long" | "short" | "neutral";

export interface EntryInput {
  entry?: "now" | "at_price" | "in_range" | undefined;
  entryPrice?: string | undefined;
  entryLow?: string | undefined;
  entryHigh?: string | undefined;
}

/** Field phẳng → điều kiện. Thiếu `entry` (config cũ) là Now; `legacy` là điều kiện cũ của chiến lược đó. */
export function entryOf(c: EntryInput, legacy?: EntryCondition): EntryCondition {
  if (c.entry === "at_price" && c.entryPrice !== undefined)
    return { type: "at_price", price: c.entryPrice };
  if (c.entry === "in_range" && c.entryLow !== undefined && c.entryHigh !== undefined)
    return { type: "in_range", low: c.entryLow, high: c.entryHigh };
  if (c.entry === undefined && legacy !== undefined) return legacy;
  return { type: "now" };
}

export interface NextCycleInput {
  nextCycle?: "immediately" | "after_pullback" | "cooldown" | "same_as_entry" | undefined;
  pullbackPct?: string | undefined;
  cooldownMinutes?: number | undefined;
}

export function nextCycleOf(c: NextCycleInput, legacy?: NextCycle): NextCycle {
  if (c.nextCycle === "after_pullback" && c.pullbackPct !== undefined)
    return { type: "after_pullback", pct: c.pullbackPct };
  if (c.nextCycle === "cooldown" && c.cooldownMinutes !== undefined)
    return { type: "cooldown", minutes: c.cooldownMinutes };
  if (c.nextCycle === "same_as_entry") return { type: "same_as_entry" };
  if (c.nextCycle === undefined && legacy !== undefined) return legacy;
  return { type: "immediately" };
}

/** Điều kiện vào đã đạt chưa ở giá `price` (giá tick trước là `prev`, null ở tick đầu). */
export function entryReady(
  entry: EntryCondition,
  direction: EntryDirection,
  prev: string | null,
  price: string,
): boolean {
  switch (entry.type) {
    case "now":
      return true;
    case "cross":
      return crossed(entry.price, prev, price);
    case "at_price":
      if (direction === "long") return lte(price, entry.price);
      if (direction === "short") return gte(price, entry.price);
      return crossed(entry.price, prev, price);
    case "in_range":
      // Giá nhảy qua cả khoảng theo chiều có lợi vẫn vào (đã chốt ở IMP-01; form có cảnh báo).
      if (direction === "long") return lte(price, entry.high);
      if (direction === "short") return gte(price, entry.low);
      return gte(price, entry.low) && lte(price, entry.high);
    case "within":
      return gte(price, entry.low) && lte(price, entry.high);
  }
}

function crossed(level: string, prev: string | null, price: string): boolean {
  return prev !== null && dec(prev).sub(level).mul(dec(price).sub(level)).lte(0);
}

/** Kiểm tra field phẳng của First entry; `range` là khoảng giá của Grid (điều kiện phải nằm trong đó). */
export function refineEntry(
  c: EntryInput,
  ctx: z.RefinementCtx,
  range?: { low: string; high: string },
): void {
  const inside = (v: string) =>
    range === undefined || (dec(v).gte(range.low) && dec(v).lte(range.high));
  if (c.entry === "at_price") {
    if (c.entryPrice === undefined)
      ctx.addIssue({ code: "custom", path: ["entryPrice"], message: "Required." });
    else if (!inside(c.entryPrice))
      ctx.addIssue({
        code: "custom",
        path: ["entryPrice"],
        message: "Must be inside the grid range.",
      });
  }
  if (c.entry === "in_range") {
    if (c.entryLow === undefined)
      ctx.addIssue({ code: "custom", path: ["entryLow"], message: "Required." });
    if (c.entryHigh === undefined)
      ctx.addIssue({ code: "custom", path: ["entryHigh"], message: "Required." });
    if (c.entryLow !== undefined && c.entryHigh !== undefined) {
      if (dec(c.entryLow).gte(c.entryHigh)) {
        ctx.addIssue({
          code: "custom",
          path: ["entryLow"],
          message: "Must be lower than the high price.",
        });
        ctx.addIssue({
          code: "custom",
          path: ["entryHigh"],
          message: "Must be higher than the low price.",
        });
      }
      for (const key of ["entryLow", "entryHigh"] as const) {
        const v = c[key];
        if (v !== undefined && !inside(v))
          ctx.addIssue({ code: "custom", path: [key], message: "Must be inside the grid range." });
      }
    }
  }
}

export function refineNextCycle(
  c: NextCycleInput & { entry?: EntryInput["entry"] },
  ctx: z.RefinementCtx,
  hasLegacyEntry = false,
): void {
  if (c.nextCycle === "after_pullback" && c.pullbackPct === undefined)
    ctx.addIssue({ code: "custom", path: ["pullbackPct"], message: "Required." });
  if (c.nextCycle === "cooldown" && c.cooldownMinutes === undefined)
    ctx.addIssue({ code: "custom", path: ["cooldownMinutes"], message: "Required." });
  if (
    c.nextCycle === "same_as_entry" &&
    (c.entry === undefined ? !hasLegacyEntry : c.entry === "now")
  )
    ctx.addIssue({
      code: "custom",
      path: ["nextCycle"],
      message: "Choose At price or In a range in First entry.",
    });
}

/** Điều kiện chờ để hiện trên UI ("Waiting for price"); dữ liệu cho `BotSummary.waiting`. */
export type WaitingInfo =
  | { kind: "entry"; condition: Exclude<EntryCondition, { type: "now" } | { type: "within" }> }
  | { kind: "pullback"; price: string }
  | { kind: "cooldown"; until: number }
  | { kind: "start_at"; at: number };

/** Điều kiện hiển thị cho UI ("Waiting for price"): "within" hiện như khoảng giá `in_range`. */
export function waitingCondition(
  entry: Exclude<EntryCondition, { type: "now" }>,
): Extract<WaitingInfo, { kind: "entry" }>["condition"] {
  return entry.type === "within" ? { type: "in_range", low: entry.low, high: entry.high } : entry;
}
