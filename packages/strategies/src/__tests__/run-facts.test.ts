import { dec } from "@drift/shared";
import { describe, expect, it } from "vitest";

import { botCostPerMillion, netCostPerMillion, settledNet } from "../run-facts";

// Số liệu phiên dùng chung cho Trading Agent (api) và tin Telegram khi bot dừng (jobs, #566).

const ledger = (o: Record<string, string> = {}) => ({
  position: "0",
  avgCost: "0",
  realized: "0",
  fees: "0",
  funding: "0",
  ...o,
});

describe("run facts", () => {
  it("netCostPerMillion: loss ÷ volume × 1M, profit → 0, no volume → null", () => {
    expect(netCostPerMillion(dec("-25"), dec("1240000"))).toBe("20.16");
    expect(netCostPerMillion(dec("3"), dec("1000"))).toBe("0");
    expect(netCostPerMillion(dec("-1"), dec("0"))).toBeNull();
  });

  it("botCostPerMillion: Market Making and Volume Builder only", () => {
    const mm = { mid: null, volume: "1000000", ledger: ledger({ fees: "30" }) };
    expect(botCostPerMillion("volume_maker", mm)).toBe("30");
    const vb = { volume: "100000", ledger: ledger({ realized: "-1", fees: "4" }) };
    expect(botCostPerMillion("volume_farm", vb)).toBe("50");
    expect(botCostPerMillion("spot_grid", { ledger: ledger() })).toBeNull();
    expect(botCostPerMillion("volume_maker", null)).toBeNull();
  });

  it("settledNet: realized − fees − funding, all copy markets summed, no ledger → null", () => {
    expect(settledNet({ ledger: ledger({ realized: "12.5", fees: "1.2", funding: "0.3" }) })).toBe(
      "11",
    );
    expect(
      settledNet({
        markets: {
          "BTC-USD": { ledger: ledger({ realized: "5", fees: "1" }) },
          "ETH-USD": { ledger: ledger({ realized: "-2", funding: "0.5" }) },
        },
      }),
    ).toBe("1.5");
    expect(settledNet({})).toBeNull();
    expect(settledNet(null)).toBeNull();
  });
});
