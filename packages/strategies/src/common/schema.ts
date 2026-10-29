import { DECIMAL_STRING_PATTERN, decimalStringSchema, dec } from "@drift/shared";
import { z } from "zod";

// Field dùng chung cho schema chiến lược. Câu lỗi chép nguyên văn từ STRATEGIES.md.

export const positiveDecimal = (message = "Must be above 0.") =>
  decimalStringSchema.refine((v) => DECIMAL_STRING_PATTERN.test(v) && dec(v).gt(0), { message });

export const optionalPositive = (message = "Must be above 0.") =>
  positiveDecimal(message).optional();

/** Phần trăm dạng chuỗi thô, ví dụ "1.5" = 1.5%. */
export const percent = (min: number, max: number, message: string) =>
  decimalStringSchema.refine(
    (v) => DECIMAL_STRING_PATTERN.test(v) && dec(v).gte(min) && dec(v).lte(max),
    { message },
  );

export const marketSchema = z.string().min(1, { message: "Required." });
