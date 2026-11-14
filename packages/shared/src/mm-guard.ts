import { z } from "zod";

/**
 * Binance guard của Market Making (`md.<market>.guard`, marketdata publish khi trạng thái đổi): giá Binance đã lệch khỏi
 * giá SoDEX (đã trừ chênh lệch nền), nên báo giá của maker trên SoDEX đang cũ. `ask`: Binance cao hơn → ask dễ bị khớp
 * ngay trước khi giá SoDEX tăng; `bid`: ngược lại. `T`: giờ Binance của lần cập nhật gây ra tín hiệu; `at`: giờ marketdata
 * gửi (đo độ trễ).
 */
export const mmGuardMessageSchema = z.object({
  s: z.string(),
  ask: z.boolean(),
  bid: z.boolean(),
  gapBp: z.number(),
  T: z.number().int(),
  at: z.number().int(),
});
export type MmGuardMessage = z.infer<typeof mmGuardMessageSchema>;
