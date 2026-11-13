import { dec } from "@drift/shared";
import { z } from "zod";

import { marketSchema, optionalPositive, percent, positiveDecimal } from "../common/schema";

// S12 Copy Trade (DEC-161, DEC-163, STRATEGIES.md S12): một bot copy MỘT ví leader trên NHIỀU market Perps của SoDEX.
// Chỉ copy vị thế leader mở SAU khi bot start; không nhảy vào vị thế cũ của leader. Config cũ (`market`) vẫn đọc được.

export const COPY_DEFAULTS = {
  leaderSource: "sodex",
  direction: "follow",
  marginMode: "isolated",
  sizing: "fixed",
  maxSlippagePct: "0.3",
} as const;

export const leaderAddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, { message: "Enter a wallet address (0x…, 42 characters)." })
  .transform((v) => v.toLowerCase());

/** Số market tối đa một bot copy theo (SoDEX hiện có ~100 perp; giữ nhỏ để kiểm tra trùng và đòn bẩy nhanh). */
export const COPY_MAX_MARKETS = 20;

/** Config trước DEC-163 có `market` (một market): đọc thành `markets: [market]`. */
const legacyMarket = (raw: unknown): unknown => {
  if (typeof raw !== "object" || raw === null) return raw;
  const { market, markets, ...rest } = raw as Record<string, unknown>;
  if (markets !== undefined || market === undefined) return raw;
  return { ...rest, markets: [market] };
};

export const copyTradeSchema = z.preprocess(
  legacyMarket,
  z
    .object({
      /** Nơi đọc lệnh của leader. Hyperliquid chỉ bật khi team bật cờ (DEC-161, bước C). */
      leaderSource: z.enum(["sodex", "hyperliquid"]).default(COPY_DEFAULTS.leaderSource),
      leaderAddress: leaderAddressSchema,
      markets: z
        .array(marketSchema)
        .min(1, { message: "Pick at least one market." })
        .max(COPY_MAX_MARKETS, { message: `Up to ${String(COPY_MAX_MARKETS)} markets.` })
        .refine((m) => new Set(m).size === m.length, { message: "Each market once." }),
      leverage: z
        .number()
        .int({ message: "Whole numbers only." })
        .min(1, { message: "Allowed 1× or more." }),
      /**
       * Đòn bẩy theo market (DEC-226), key là market trong `markets`; thiếu thì dùng `leverage`.
       * Khoá sau khi tạo bot (như `markets`).
       */
      leverageByMarket: z
        .record(
          marketSchema,
          z
            .number()
            .int({ message: "Whole numbers only." })
            .min(1, { message: "Allowed 1× or more." }),
        )
        .optional(),
      marginMode: z.enum(["cross", "isolated"]).default(COPY_DEFAULTS.marginMode),
      /** `inverse` vào lệnh ngược chiều leader. */
      direction: z.enum(["follow", "inverse"]).default(COPY_DEFAULTS.direction),
      /** `fixed`: mỗi vị thế mới của leader mở `fixedNotional`. `ratio`: vị thế = `ratioPct`% vị thế của leader. */
      sizing: z.enum(["fixed", "ratio"]).default(COPY_DEFAULTS.sizing),
      fixedNotional: optionalPositive("Below SoDEX minimum order size."),
      ratioPct: percent(0.01, 100, "Allowed 0.01–100%.").optional(),
      /** Trần giá trị (quote, đã gồm đòn bẩy) của một lệnh mở hoặc tăng vị thế. */
      maxNotionalPerTrade: positiveDecimal(),
      /** Trần giá trị vị thế của bot (quote). */
      maxExposure: positiveDecimal(),
      /** Lệnh mở / tăng là IOC giới hạn tại giá tham chiếu ± mức này; giá chạy xa hơn thì bỏ qua. */
      maxSlippagePct: percent(0.05, 2, "Allowed 0.05–2%.").default(COPY_DEFAULTS.maxSlippagePct),
      /** Giá đi ngược so với giá vốn chừng này % thì đóng vị thế và chờ leader mở vị thế mới. */
      stopLossPct: percent(0.5, 90, "Allowed 0.5–90%.").optional(),
      /** Giá đi đúng hướng chừng này % thì chốt và chờ leader mở vị thế mới. */
      takeProfitPct: percent(0.5, 500, "Allowed 0.5–500%.").optional(),
      /** Lỗ ròng của bot chạm mức này thì dừng và đóng vị thế. */
      maxLoss: positiveDecimal(),
    })
    .superRefine((c, ctx) => {
      for (const m of Object.keys(c.leverageByMarket ?? {}))
        if (!c.markets.includes(m))
          ctx.addIssue({
            code: "custom",
            path: ["leverageByMarket", m],
            message: "Market is not in this copy bot.",
          });
      if (c.sizing === "fixed" && c.fixedNotional === undefined)
        ctx.addIssue({ code: "custom", path: ["fixedNotional"], message: "Required." });
      if (c.sizing === "ratio" && c.ratioPct === undefined)
        ctx.addIssue({ code: "custom", path: ["ratioPct"], message: "Required." });
      if (dec(c.maxExposure).lt(dec(c.maxNotionalPerTrade)))
        ctx.addIssue({
          code: "custom",
          path: ["maxExposure"],
          message: "Must be at least the max per trade.",
        });
      if (
        c.sizing === "fixed" &&
        c.fixedNotional !== undefined &&
        dec(c.fixedNotional).gt(dec(c.maxNotionalPerTrade))
      )
        ctx.addIssue({
          code: "custom",
          path: ["fixedNotional"],
          message: "Must not exceed the max per trade.",
        });
    }),
);

export type CopyTradeConfig = z.infer<typeof copyTradeSchema>;
