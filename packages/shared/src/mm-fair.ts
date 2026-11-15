import { z } from "zod";

/**
 * Giá Binance quy đổi về SoDEX của một market (`md.<market>.fair`, marketdata publish): giá giữa Binance USDT-M futures
 * của cùng coin chia cho chênh lệch nền với SoDEX (trung vị 60 s). Bot Market Making bật Smart quoting dùng làm giá hợp
 * lý: không đặt lệnh mở thêm vị thế vượt giá này. `T`: giờ Binance của lần cập nhật; `at`: giờ marketdata gửi.
 */
export const mmFairMessageSchema = z.object({
  s: z.string(),
  fair: z.string(),
  T: z.number().int(),
  at: z.number().int(),
});
export type MmFairMessage = z.infer<typeof mmFairMessageSchema>;

/**
 * Giá mua / bán tốt nhất trên SoDEX của một market (`md.<market>.book`, marketdata publish từ WS `bookTicker`, DEC-248),
 * chỉ khi giá đổi và chỉ cho market có bot Market Making. `E`: giờ SoDEX; `at`: giờ marketdata nhận.
 */
export const mmBookMessageSchema = z.object({
  s: z.string(),
  b: z.string(),
  a: z.string(),
  E: z.number().int(),
  at: z.number().int(),
});
export type MmBookMessage = z.infer<typeof mmBookMessageSchema>;
