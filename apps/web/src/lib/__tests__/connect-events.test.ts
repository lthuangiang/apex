// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { deviceInfo, errorInfo, shortWallet } from "../connect-events";

const setUa = (ua: string, touch = 0) => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
  Object.defineProperty(navigator, "maxTouchPoints", { value: touch, configurable: true });
};

window.matchMedia = vi.fn().mockReturnValue({ matches: false });

afterEach(() => {
  vi.restoreAllMocks();
  window.matchMedia = vi.fn().mockReturnValue({ matches: false });
  delete (window as { ethereum?: unknown }).ethereum;
});

describe("connect events (DEC-114)", () => {
  it("tells mobile wallet browsers, iOS Chrome and desktop apart", () => {
    setUa(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1 OKApp/(OKEx/6.90.0)",
    );
    (window as { ethereum?: unknown }).ethereum = { isOkxWallet: true, isMetaMask: true };
    expect(deviceInfo()).toMatchObject({
      device: "mobile",
      os: "iOS",
      browser: "OKX in-app",
      hasEthereum: true,
      ethereumFlags: ["isMetaMask", "isOkxWallet"],
    });

    delete (window as { ethereum?: unknown }).ethereum;
    setUa(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1",
    );
    expect(deviceInfo()).toMatchObject({ device: "mobile", browser: "Chrome", hasEthereum: false });

    // iPad ở chế độ desktop báo UA của Mac.
    setUa(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
      5,
    );
    expect(deviceInfo()).toMatchObject({ device: "mobile", os: "iOS", browser: "Safari" });

    setUa(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    );
    expect(deviceInfo()).toMatchObject({ device: "desktop", os: "Windows", browser: "Chrome" });
  });

  it("keeps only the error name, a short message and the code", () => {
    const e = Object.assign(new Error("x".repeat(500)), {
      name: "UserRejectedRequestError",
      shortMessage: "User rejected the request.",
      code: 4001,
    });
    expect(errorInfo(e)).toEqual({
      reason: "UserRejectedRequestError",
      message: "User rejected the request.",
      code: "4001",
    });
    expect(errorInfo("nope")).toEqual({ reason: "unknown" });
    expect(shortWallet("0x4E1e4796c10C637EDAB56461450BD8D02EFb29Db")).toBe("0x4E1e…29Db");
  });
});
