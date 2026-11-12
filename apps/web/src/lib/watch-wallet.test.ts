import { describe, expect, it, vi } from "vitest";

import { connectWatched, WalletConnectNotStarted } from "./watch-wallet";

function fakeConnector(type: string) {
  const handlers = new Set<(m: { type: string }) => void>();
  return {
    type,
    emitter: {
      on: (_e: string, h: (m: { type: string }) => void) => handlers.add(h),
      off: (_e: string, h: (m: { type: string }) => void) => handlers.delete(h),
    },
    send: (type: string) => {
      for (const h of handlers) h({ type });
    },
  };
}
type Watched = Parameters<typeof connectWatched>[0];

describe("connectWatched", () => {
  it("fails with a clear error when WalletConnect never shows a QR", async () => {
    vi.useFakeTimers();
    const c = fakeConnector("walletConnect");
    const run = connectWatched(c as unknown as Watched, () => new Promise(() => undefined), 100);
    const check = expect(run).rejects.toBeInstanceOf(WalletConnectNotStarted);
    await vi.advanceTimersByTimeAsync(100);
    await check;
    vi.useRealTimers();
  });

  it("waits as long as needed once the QR is on screen", async () => {
    vi.useFakeTimers();
    const c = fakeConnector("walletConnect");
    let done: (v: string) => void = () => undefined;
    const run = connectWatched(
      c as unknown as Watched,
      () => new Promise<string>((r) => (done = r)),
      100,
    );
    c.send("display_uri");
    await vi.advanceTimersByTimeAsync(10_000);
    done("ok");
    await expect(run).resolves.toBe("ok");
    vi.useRealTimers();
  });

  it("does not time out browser wallets", async () => {
    const c = fakeConnector("injected");
    await expect(
      connectWatched(c as unknown as Watched, () => Promise.resolve("ok"), 1),
    ).resolves.toBe("ok");
  });
});
