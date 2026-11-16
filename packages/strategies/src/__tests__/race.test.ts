import { describe, expect, it } from "vitest";

import type { StepContext } from "../core/types";
import { runRace, type RaceProbe } from "../sim/race";
import { volumeMaker, type VolumeMakerState } from "../volume-maker";
import { vmMaxInventory, volumeMakerSchema } from "../volume-maker/schema";

// Harness tranh chấp thuần (DEC-TBD-race-harness): Market Making chạy nhiều phút giả lập trên SoDEX giả có độ trễ ngẫu
// nhiên, đảo thứ tự, OrderNotFound khi huỷ lệnh chưa vào sổ. Seed cố định để tái hiện; RACE_SEEDS / RACE_MINUTES để chạy
// nhiều hơn ở máy (CI chạy ít). Bắt được lỗi DEC-251 (bot đứng không báo giá) và DEC-253 (lệnh mồ côi làm vị thế gấp
// đôi, cùng lỗi huỷ + đặt cùng lúc của DEC-257) khi revert bản sửa (kết quả ghi trong PR).

// Không có kiểu Node trong package này: đọc env qua globalThis.
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env;
/** In số liệu khi RACE_LOG=1 (package này không có kiểu Node / DOM cho `console`). */
const say = (line: string) =>
  (globalThis as { console?: { log: (s: string) => void } }).console?.log(line);
const SEEDS = Number(env?.RACE_SEEDS ?? "3");
const MINUTES = Number(env?.RACE_MINUTES ?? "16");

const ctx: StepContext = {
  botId: "race-bot",
  version: 1,
  rules: {
    "BTC-USD": { tickSize: "0.1", stepSize: "0.0001", minQuantity: "0.0001", minNotional: "5" },
  },
  feeRate: "0.00065",
};

const probe: RaceProbe<VolumeMakerState> = {
  position: (s) => s.ledger.position,
  lastRefresh: (s) => s.lastRefresh,
  isDone: (s, id) => {
    const o = s.orders[id];
    return o === undefined || o.status === "done";
  },
  halted: (s) => s.phase === "halted",
};

// "Holds up to 1": một lệnh mỗi phía, nên lệnh mồ côi khớp cùng lệnh mới là vượt giới hạn.
const config = (smartQuoting: boolean) =>
  volumeMakerSchema.parse({
    market: "BTC-USD",
    leverage: 1,
    orderSize: "500",
    distanceBp: "1",
    maxOrders: 1,
    refreshSeconds: 3,
    runUntil: "target_or_budget",
    costBudget: "1000000",
    onStop: "close_inventory",
    smartQuoting,
  });

describe("Market Making race harness (DEC-TBD-race-harness)", () => {
  for (const smart of [false, true])
    for (let seed = 1; seed <= SEEDS; seed += 1)
      it(
        `keeps the money invariants (seed ${String(seed)}, Smart quoting ${smart ? "on" : "off"})`,
        { timeout: 60_000 },
        () => {
          const c = config(smart);
          const r = runRace(volumeMaker, c, ctx, {
            seed: seed * (smart ? 7919 : 1),
            durationMs: MINUTES * 60_000,
            market: "BTC-USD",
            startPrice: 100_000,
            tickSize: 0.1,
            positionLimit: vmMaxInventory(c),
            // Bất biến 5: bình thường bot xét báo giá mỗi `refreshSeconds`; quá thêm 2 s là đứng (DEC-251).
            maxGapMs: c.refreshSeconds * 1000 + 2000,
            // Smart quoting: giá Binance mỗi 250 ms, lệch ngẫu nhiên tới 3 bp quanh giá SoDEX. Nhiễu này cố ý mạnh hơn BTC lúc
            // thường để có nhiều lần rút / đặt lại (tranh chấp); số request / phút ở đây (~70–110) không phải ước lượng prod
            // (bot thật đo 26–48). Giới hạn request / phút kiểm ở `request-rate.test.ts`.
            ...(smart ? { fairEveryMs: 250, fairNoiseBp: 3 } : {}),
            driftBp: Number(env?.RACE_DRIFT ?? "0"),
            probe,
          });
          if (env?.RACE_LOG === "1")
            say(
              JSON.stringify({
                smart,
                seed,
                fills: r.fills,
                maxNotional: r.maxNotional,
                rpm: r.maxRequestsPerMinute,
                gap: r.maxGapMs,
                v: r.violations.length,
              }),
            );
          // Kịch bản phải thật sự có tranh chấp, không thì "đạt" chẳng chứng minh gì.
          expect(r.notFound).toBeGreaterThan(0);
          expect(r.fills).toBeGreaterThan(10);
          expect(r.violations).toEqual([]);
        },
      );
});
