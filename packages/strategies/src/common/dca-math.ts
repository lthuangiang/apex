import { dec, Decimal } from "@drift/shared";

// Tách khỏi `dca-bot.ts` để schema và web (`@drift/strategies/client`) dùng mà không kéo logic bước của bot DCA.

/** % khoảng cách luỹ kế tới safety thứ k (1-based). */
export function safetyOffsetPct(
  c: { readonly firstStepPct: string; readonly stepMultiplier: string },
  k: number,
): Decimal {
  let total = new Decimal(0);
  for (let i = 0; i < k; i += 1) total = total.add(dec(c.stepMultiplier).pow(i));
  return dec(c.firstStepPct).mul(total);
}
