import { dec } from "@drift/shared";
import { z } from "zod";

import { marketSchema, positiveDecimal } from "../common/schema";

// S9 Volume Maker (STRATEGIES.md, VOLUME_MAKER.md mục 17). Mọi SoDEX perp (DEC-157), chỉ lệnh post-only. Câu lỗi chép
// nguyên văn từ STRATEGIES.md. Form gọn (DEC-99): người dùng chỉ nhập Order size và Stop if I lose; các field còn
// lại có mặc định ở đây, nên config cũ (đủ field) và config mới (thiếu field) đều parse được.
export const VM_LEVERAGE_MAX = 40;
export const VM_DEFAULTS = {
  leverage: 5,
  distanceBp: "1",
  refreshSeconds: 3,
  /** Max open position = 2 × order size khi không đặt (DEC-100). */
  maxInventoryMultiple: 2,
} as const;

export const volumeMakerSchema = z
  .object({
    market: marketSchema,
    leverage: z
      .number()
      .int()
      .min(1, { message: "Allowed 1–40×." })
      .max(VM_LEVERAGE_MAX, { message: "Allowed 1–40×." })
      .default(VM_DEFAULTS.leverage),
    /** Thiếu = không dừng theo khối lượng (Stop after trading: None). */
    volumeTarget: positiveDecimal().optional(),
    orderSize: positiveDecimal("Below SoDEX minimum order size."),
    distanceBp: positiveDecimal("Must be at least one tick.").default(VM_DEFAULTS.distanceBp),
    /**
     * Vị trí báo giá theo sổ lệnh (DEC-135), thay `distanceBp` cho config mới: 0 = giá tốt nhất mỗi phía (spread từ
     * 3 tick trở lên thì vào trong spread 1 tick), n = lùi n tick. Tự đúng với mọi market vì tính theo tick và sổ lệnh
     * thật. Thiếu (config cũ) = báo giá theo `distanceBp` quanh giá khớp gần nhất như trước.
     */
    /**
     * Smart quoting (DEC-144), mặc định tắt: lùi phía sắp bị cuốn khi sổ lệnh lệch hẳn một bên hoặc giá vừa chạy nhanh.
     * Tắt = đúng logic cũ. Chỉ có tác dụng khi báo giá theo sổ lệnh (`quoteLevel`).
     */
    smartQuoting: z.boolean().default(false),
    quoteLevel: z
      .number()
      .int({ message: "Whole numbers only." })
      .min(0, { message: "Allowed 0–20." })
      .max(20, { message: "Allowed 0–20." })
      .optional(),
    /** Config trước DEC-133: vị thế tối đa theo USDC. Có thì dùng; form mới gửi `maxOrders`. */
    maxInventory: positiveDecimal().optional(),
    /**
     * Vị thế tối đa tính bằng số lệnh của một phía (DEC-133): 1 = giữ tối đa đúng một order size, sau đó chỉ đặt lệnh
     * đóng. Thiếu cả hai = 2 lệnh (DEC-100).
     */
    maxOrders: z
      .number()
      .int({ message: "Whole numbers only." })
      .min(1, { message: "Allowed 1–10." })
      .max(10, { message: "Allowed 1–10." })
      .optional(),
    refreshSeconds: z
      .number()
      .int()
      .min(2, { message: "Allowed 2–60 s." })
      .max(60, { message: "Allowed 2–60 s." })
      .default(VM_DEFAULTS.refreshSeconds),
    runUntil: z.enum(["season_end", "date", "target_or_budget"]).default("target_or_budget"),
    /** ms; bắt buộc khi `runUntil` là `season_end` hoặc `date`. */
    untilAt: z.number().int().positive().optional(),
    costBudget: positiveDecimal(),
    /** Thiếu = chỉ dừng theo Cost budget (chi phí đã gồm lỗ chưa chốt). */
    inventoryLossStop: positiveDecimal().optional(),
    onStop: z.enum(["close_inventory", "keep_position"]).default("close_inventory"),
  })
  .superRefine((c, ctx) => {
    if (c.maxInventory !== undefined && !dec(c.maxInventory).gt(c.orderSize))
      ctx.addIssue({
        code: "custom",
        path: ["maxInventory"],
        message: "Must be above the order size.",
      });
    if (c.inventoryLossStop !== undefined && !dec(c.inventoryLossStop).lt(c.costBudget))
      ctx.addIssue({
        code: "custom",
        path: ["inventoryLossStop"],
        message: "Must be below the budget.",
      });
    if (c.runUntil !== "target_or_budget" && c.untilAt === undefined)
      ctx.addIssue({ code: "custom", path: ["untilAt"], message: "Required." });
  });
export type VolumeMakerConfig = z.infer<typeof volumeMakerSchema>;

/** Max open position thực dùng (USDC): `maxInventory` cũ, hoặc `maxOrders` × order size, mặc định 2 lệnh (DEC-100). */
export function vmMaxInventory(
  c: Pick<VolumeMakerConfig, "maxInventory" | "orderSize"> & { maxOrders?: number | undefined },
): string {
  return (
    c.maxInventory ??
    dec(c.orderSize)
      .mul(c.maxOrders ?? VM_DEFAULTS.maxInventoryMultiple)
      .toString()
  );
}
