import { describe, expect, it } from "vitest";

import { liveBookPlan, VF_EXTRA_LIVE_MARKETS } from "../mm-cost-store";

// DEC-TBD-vb-live-book: market Volume Farm thêm vào kết nối WS có giới hạn, top ∪ MM (DEC-227) luôn đi trước.
describe("liveBookPlan", () => {
  it("keeps top and Market Making markets, then adds Volume Farm markets up to the cap", () => {
    const farm = ["ETH-USD", "Z1-USD", "Z2-USD", "Z3-USD"];
    const p = liveBookPlan(["BTC-USD", "ETH-USD"], ["SOL-USD"], farm, 2);
    expect(p.watched).toEqual(["BTC-USD", "ETH-USD", "SOL-USD", "Z1-USD", "Z2-USD"]);
    // ETH-USD đã trong top: không tính vào phần thêm.
    expect(p.relay).toEqual(["SOL-USD", "ETH-USD", "Z1-USD", "Z2-USD"]);
    expect(p.dropped).toEqual(["Z3-USD"]);
  });

  it("adds nothing beyond the default cap", () => {
    const farm = Array.from({ length: VF_EXTRA_LIVE_MARKETS + 3 }, (_, i) => `X${String(i)}-USD`);
    const p = liveBookPlan([], [], farm);
    expect(p.watched).toHaveLength(VF_EXTRA_LIVE_MARKETS);
    expect(p.dropped).toHaveLength(3);
  });
});
