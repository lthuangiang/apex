import { afterEach, describe, expect, it, vi } from "vitest";

// #368: tạo config wagmi ở server (Node, không có `indexedDB`) không được khởi tạo WalletConnect, nếu không SSR ghi
// `unhandledRejection: ReferenceError: indexedDB is not defined`. Ở trình duyệt vẫn có WalletConnect như trước.

const PROJECT_ID = "0123456789abcdef0123456789abcdef";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

// Import lần đầu wagmi / viem / connectors mất vài giây khi máy tải nặng (từng vượt 5 s mặc định).
describe("wagmi config on the server (#368)", { timeout: 30_000 }, () => {
  it("creates the config without WalletConnect and without an unhandled rejection", async () => {
    expect(typeof window).toBe("undefined");
    expect(typeof indexedDB).toBe("undefined");
    vi.stubEnv("NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID", PROJECT_ID);
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => {
      rejections.push(e);
    };
    process.on("unhandledRejection", onRejection);
    try {
      const { wagmiConfig, walletConnectProjectId } = await import("../wagmi");
      expect(walletConnectProjectId).toBe(PROJECT_ID);
      // Đủ thời gian cho dynamic import + init của EthereumProvider nếu nó (sai) được gọi.
      await new Promise((r) => setTimeout(r, 1_000));
      expect(rejections.map(String)).toEqual([]);
      expect(wagmiConfig.connectors.map((c) => c.type)).toEqual(["injected"]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});

describe("wagmiConnectors", { timeout: 30_000 }, () => {
  it("adds WalletConnect only in the browser and only with a project id", async () => {
    const { wagmiConnectors } = await import("../wagmi");
    // Chỉ cần `window.location.origin` cho metadata; connector chưa được setup nên không khởi tạo gì.
    vi.stubGlobal("window", { location: { origin: "https://desklabs.xyz" } });
    expect(wagmiConnectors(PROJECT_ID, true)).toHaveLength(2);
    expect(wagmiConnectors("", true)).toHaveLength(1);
    expect(wagmiConnectors(PROJECT_ID, false)).toHaveLength(1);
  });
});
