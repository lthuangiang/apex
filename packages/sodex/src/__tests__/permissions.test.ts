import { describe, expect, it } from "vitest";

import { blocksWithdrawAndTransfer, DRIFT_API_KEY_PERMISSIONS } from "../permissions";

describe("API key permissions", () => {
  it("disables cancel, withdraw and transfer for the DRIFT key", () => {
    expect(DRIFT_API_KEY_PERMISSIONS).toBe(14n);
    expect(blocksWithdrawAndTransfer(DRIFT_API_KEY_PERMISSIONS)).toBe(true);
  });

  it("treats a key without a mask as able to withdraw", () => {
    expect(blocksWithdrawAndTransfer(undefined)).toBe(false);
    expect(blocksWithdrawAndTransfer(0n)).toBe(false);
  });

  it("requires both withdraw and transfer to be blocked", () => {
    expect(blocksWithdrawAndTransfer(4n)).toBe(false);
    expect(blocksWithdrawAndTransfer(8n)).toBe(false);
    expect(blocksWithdrawAndTransfer(12n)).toBe(true);
  });
});
