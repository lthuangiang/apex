import { describe, expect, it } from "vitest";

import { catalogFor, DEFAULT_CATALOG_FEATURES } from "../catalog";

// Strategy Lab và Landing đếm cùng một danh mục (báo cáo test E20). Adaptive DCA (Beta) bật cho mọi tài khoản
// (DEC-218): tài khoản mới thấy 12 chiến lược.

describe("strategy catalog", () => {
  it("counts what a new account sees in Strategy Lab", () => {
    const c = catalogFor(DEFAULT_CATALOG_FEATURES);
    expect(c.slice(0, 2)).toEqual(["volume_maker", "volume_farm"]);
    expect(c).toContain("copy_trade");
    expect(c).toContain("adaptive_dca");
    expect(c).toHaveLength(12);
  });

  it("drops Adaptive DCA when the team turns it off for an account", () => {
    expect(catalogFor({ ...DEFAULT_CATALOG_FEATURES, adaptiveDca: false })).not.toContain(
      "adaptive_dca",
    );
  });

  it("follows the account's flags", () => {
    const off = catalogFor({
      volumeMaker: false,
      volumeFarm: false,
      adaptiveDca: false,
      aiDesk: false,
    });
    expect(off).toHaveLength(8);
    const all = catalogFor({
      volumeMaker: true,
      volumeFarm: true,
      adaptiveDca: true,
      aiDesk: true,
    });
    expect(all).toHaveLength(12);
  });
});
