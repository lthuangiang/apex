import { describe, expect, it } from "vitest";

import { accountLeverageDefault, emptyValues, VF_DEFAULT_LEVERAGE } from "../fields";

// CB-01 (người dùng chọn, 16/11): Volume Builder lấy đòn bẩy SoDEX đang đặt cho market của account, tối đa 25×; cỡ lệnh
// giữ 100–200 USDC (DEC-133).

describe("Volume Builder defaults (CB-01)", () => {
  it("keeps 25× and 100–200 USDC when the account's leverage is unknown", () => {
    const v = emptyValues("volume_farm");
    expect(v.leverage).toBe(String(VF_DEFAULT_LEVERAGE));
    expect(v.orderSizeMinUsd).toBe("100");
    expect(v.orderSizeMaxUsd).toBe("200");
    expect(accountLeverageDefault(undefined)).toBeNull();
    expect(accountLeverageDefault(null)).toBeNull();
  });

  it("uses the leverage the account already has on SoDEX, capped at 25×", () => {
    expect(accountLeverageDefault(10)).toBe("10");
    expect(accountLeverageDefault("3")).toBe("3");
    expect(accountLeverageDefault(40)).toBe("25");
  });

  it("ignores values that are not a whole leverage", () => {
    expect(accountLeverageDefault("abc")).toBeNull();
    expect(accountLeverageDefault(0)).toBeNull();
    expect(accountLeverageDefault(2.5)).toBeNull();
  });
});
