import { dec } from "@drift/shared";
import { z } from "zod";

import { marketSchema, optionalPositive, percent, positiveDecimal } from "../common/schema";

// S10 Volume Farm (DEC-80, port FarmMicro của bot "standard" trong apex): vào lệnh một chiều theo cấu trúc
// nến 1 phút + sổ lệnh, giữ ngẫu nhiên trong [minHoldSecs, maxHoldSecs], thoát theo TP / SL / hết giờ, nghỉ
// `cooldownSecs` rồi lặp lại để tạo khối lượng. Chỉ hiện cho account được admin bật (Users › Volume bots).
// Đòn bẩy tối đa theo `maxLeverage` của market trên SoDEX (api kiểm tra lúc tạo / sửa).
// Stop loss gốc trên SoDEX (DEC-118) và dời về hoà vốn khi lãi (DEC-120). Phần scalp theo ATR (DEC-102) đã bỏ:
// config cũ có `exits`, `tpAtr`… vẫn nạp được (zod bỏ key lạ) và chạy theo TP USDC / SL % mặc định.

/** Mặc định của bot SoDEX "standard" trong apex (bot-configs.json, DEC-80). */
export const VF_DEFAULTS = {
  tpUsd: "0.5",
  /** % margin (như TP/SL của SoDEX, DEC-126): ở 5× là 5% giá, đúng mặc định cũ. */
  slMarginPct: "25",
  // DEC-130 (phân tích 724 lượt trên prod): thoát sớm khi lãi giá ≥ 3 lần phí khứ hồi, xét từ giây thứ 10. Mức cũ
  // 0.15 USDC cố định: lệnh 500 USDC chỉ cần 0.03% giá, dưới phí khứ hồi 0.036%, nên "chốt lời" mà vẫn lỗ ròng;
  // lệnh 100 USDC lại cần 0.15%, gần như không bao giờ tới.
  earlyExitSecs: 10,
  earlyProfitFees: "3",
} as const;

export const volumeFarmSchema = z
  .object({
    market: marketSchema,
    leverage: z
      .number()
      .int({ message: "Whole numbers only." })
      .min(1, { message: "Allowed 1× or more." }),
    marginMode: z.enum(["cross", "isolated"]),
    /** Notional mỗi lệnh (quote, đã nhân đòn bẩy), chọn ngẫu nhiên trong [min, max]. */
    orderSizeMinUsd: positiveDecimal("Below SoDEX minimum order size."),
    orderSizeMaxUsd: positiveDecimal("Below SoDEX minimum order size."),
    minHoldSecs: z.number().int().min(10, { message: "Allowed 10–3600 s." }).max(3600, {
      message: "Allowed 10–3600 s.",
    }),
    maxHoldSecs: z.number().int().min(10, { message: "Allowed 10–3600 s." }).max(3600, {
      message: "Allowed 10–3600 s.",
    }),
    /** Chốt lời khi lãi (trước phí) ≥ max(tpUsd, 1.5 × phí khứ hồi). */
    tpUsd: positiveDecimal().default(VF_DEFAULTS.tpUsd),
    /**
     * Cắt lỗ theo % margin như TP/SL của SoDEX (DEC-126): giá cắt = giá vào ∓ slMarginPct / đòn bẩy %. Dưới 100% nên
     * luôn trước thanh lý ở Isolated.
     */
    slMarginPct: percent(1, 90, "Allowed 1–90%.").default(VF_DEFAULTS.slMarginPct),
    /** Config trước DEC-126: cắt lỗ theo % giá. Có thì dùng (giữ đúng mức đang chạy); form mới không gửi. */
    slPct: percent(0.1, 50, "Allowed 0.1–50%.").optional(),
    /** Sau ngần này giây, lãi giá ≥ ngưỡng thoát sớm thì thoát. */
    earlyExitSecs: z.number().int().min(0).max(3600).default(VF_DEFAULTS.earlyExitSecs),
    /** Ngưỡng thoát sớm: bội số của phí khứ hồi của lượt (DEC-130). Tối thiểu 1 lần, để thoát sớm không lỗ phí. */
    earlyProfitFees: percent(1, 20, "Allowed 1–20× fees.").default(VF_DEFAULTS.earlyProfitFees),
    /** Config trước DEC-130: ngưỡng USDC cố định. Có thì ngưỡng = max(mức này, bội số phí); form mới không gửi. */
    earlyProfitUsd: positiveDecimal().optional(),
    cooldownSecs: z.number().int().min(0).max(3600).default(30),
    /** Đảo chiều tín hiệu (apex `farmReverseSignalEnabled`). */
    reverseSignal: z.boolean().default(false),
    /** Chỉ vào lượt mới khi regime 5 phút là SIDEWAY (DEC-158). Lượt đang mở vẫn thoát như thường. */
    sidewaysOnly: z.boolean().default(false),
    /** Sau `takerAfter` lần lệnh post-only không khớp liên tiếp thì vào / thoát bằng lệnh taker. */
    allowTaker: z.boolean().default(false),
    takerAfter: z
      .number()
      .int({ message: "Whole numbers only." })
      .min(1, { message: "Allowed 1–10." })
      .max(10, { message: "Allowed 1–10." })
      .default(3),
    /**
     * Đặt stop loss gốc trên SoDEX cho mỗi lượt (DEC-118): kích hoạt theo mark price, đóng cả vị thế bằng market,
     * kể cả khi DRIFT không chạy. Lãi đủ thì dời về hoà vốn (DEC-120). Config cũ mặc định bật.
     */
    exchangeStop: z.boolean().default(true),
    /**
     * Dời stop trên SoDEX về hoà vốn khi lãi giá đạt ngần này lần G (phí vào + phí taker ra + trượt giá) (DEC-143).
     * Khoá lời và bám giá tốt nhất từ (mức này + 2) × G. Mặc định 2 (người dùng chọn; trước đây cố định 4, ít khi tới).
     */
    stopMoveFees: percent(1, 20, "Allowed 1–20× fees.").default("2"),
    /** Bỏ qua lượt vào khi spread > ngưỡng này (bp). */
    maxSpreadBps: percent(0.1, 500, "Allowed 0.1–500 bp.").default("10"),
    /** Giờ UTC không vào lệnh mới. */
    blockedHoursUtc: z.array(z.number().int().min(0).max(23)).max(24).default([]),
    /** Dừng khi lỗ ròng (đã chốt + phí) đạt mức này. */
    maxLoss: positiveDecimal(),
    /** Dừng khi đạt khối lượng này (quote); bỏ trống = chạy tới khi dừng tay. */
    volumeTarget: optionalPositive(),
  })
  .superRefine((c, ctx) => {
    if (dec(c.orderSizeMaxUsd).lt(c.orderSizeMinUsd))
      ctx.addIssue({
        code: "custom",
        path: ["orderSizeMaxUsd"],
        message: "Must be at least the minimum size.",
      });
    if (c.maxHoldSecs < c.minHoldSecs)
      ctx.addIssue({
        code: "custom",
        path: ["maxHoldSecs"],
        message: "Must be at least the minimum hold.",
      });
  });
export type VolumeFarmConfig = z.infer<typeof volumeFarmSchema>;
