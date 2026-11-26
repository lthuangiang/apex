// @vitest-environment jsdom
import { SODEX_REWARDS_DEFAULT_ORIGIN } from "@drift/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { rewardsRequest, rewardsUrl, resetRewardsRateLimit } from "../client";
import { runAllProbes } from "../probes";
import { signInToRewards } from "../sign-in";
import { readRewardsToken } from "../token-store";

import { bodyOf, urlOf } from "./fetch-helpers";

// #547: token rewards không bao giờ rời trình duyệt tới origin DeskLabs. Chạy cả luồng đăng nhập và mọi probe đọc của
// trang chẩn đoán với fetch giả, rồi kiểm từng request.

const MASTER = "0x3f2a000000000000000000000000000000009c4e";
const FAKE_TOKEN = "fake-test-value";

function fakeGateway() {
  return vi.fn<typeof fetch>((input) => {
    const path = new URL(urlOf(input)).pathname.replace("/api/v1/", "");
    const data: unknown =
      path === "auth/nonce"
        ? { message: "challenge" }
        : path === "auth/verify"
          ? { accessToken: FAKE_TOKEN }
          : path === "lottery/jobs"
            ? { jobs: [{ jobId: 7, kind: "open", status: "pending" }] }
            : path === "lottery/pfps"
              ? { total: 1, pfps: [{ profileTokenId: 2051, source: "box" }], won: [] }
              : {};
    const body = path.startsWith("cybereator/")
      ? { id: 2051, stage: "unopened" }
      : { code: 0, msg: "success", data };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetRewardsRateLimit();
  sessionStorage.clear();
});

describe("rewards token never reaches DeskLabs", () => {
  it("sign-in and every diagnostics read only call the SoDEX gateway", async () => {
    const f = fakeGateway();
    vi.stubGlobal("fetch", f);
    await signInToRewards({
      master: MASTER,
      connected: MASTER,
      signMessage: () => Promise.resolve("0xsig"),
    });
    const token = readRewardsToken(MASTER);
    expect(token).toBe(FAKE_TOKEN);
    await runAllProbes(
      (req) => rewardsRequest({ ...req, token }),
      () => undefined,
    );

    expect(f.mock.calls.length).toBeGreaterThan(10);
    const paths = f.mock.calls.map(([u]) => new URL(urlOf(u)).pathname);
    expect(paths).toContain("/api/v1/lottery/job/7");
    expect(paths).toContain("/api/v1/cybereator/profile/2051");
    for (const [input, init] of f.mock.calls) {
      const url = new URL(urlOf(input));
      expect(url.origin).toBe(SODEX_REWARDS_DEFAULT_ORIGIN);
      expect(url.origin).not.toBe(window.location.origin);
      expect(url.toString()).not.toContain(FAKE_TOKEN);
      expect(bodyOf(init)).not.toContain(FAKE_TOKEN);
      expect(init?.credentials).toBe("omit");
      // Không có endpoint ghi nào trong chẩn đoán: POST chỉ có auth/nonce và auth/verify.
      if (init?.method === "POST")
        expect(url.pathname).toMatch(/^\/api\/v1\/auth\/(nonce|verify)$/);
    }
  });

  it("refuses to build a rewards URL on the DeskLabs origin", () => {
    expect(() => rewardsUrl("lottery/boxes", {}, window.location.origin)).toThrow();
  });
});
