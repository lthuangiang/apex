// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { SODEX_REWARDS_DEFAULT_ORIGIN } from "@drift/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { rewardsRequest, rewardsUrl, resetRewardsRateLimit } from "../client";
import { runAllProbes } from "../probes";
import { signInToRewards } from "../sign-in";
import { readRewardsToken } from "../token-store";

import { bodyOf, urlOf } from "./fetch-helpers";

// #547: token rewards không rời trình duyệt tới origin DeskLabs, với MỘT ngoại lệ (#558, DEC-398): khi người dùng để
// công tắc "Tell me about new boxes" bật, `POST /api/v1/rewards/watch` gửi token đúng một lần (test luồng đó ở
// `rewards-watch-ui.test.tsx`: chỉ POST đó mang token; gạt tắt thì không có request nào tới DeskLabs mang token). Ở đây:
// luồng đăng nhập và mọi probe đọc của trang chẩn đoán chỉ gọi gateway SoDEX; trong feature rewards chỉ `watch.ts` vừa
// đọc token vừa gọi API DeskLabs.

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
  localStorage.clear();
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

  it("only watch.ts both reads the token and calls the DeskLabs API (the one allowed POST)", () => {
    // Môi trường jsdom: `import.meta.url` không phải file://; vitest chạy từ apps/web.
    const dir = join(process.cwd(), "src/features/rewards");
    const files = readdirSync(dir, { recursive: true })
      .map(String)
      .filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes("__tests__"));
    const both = files.filter((f) => {
      const src = readFileSync(join(dir, f), "utf8");
      return src.includes("readRewardsToken(") && src.includes('"@/lib/api"');
    });
    expect(both).toEqual(["watch.ts"]);
    const watch = readFileSync(join(dir, "watch.ts"), "utf8");
    // Token chỉ nằm trong body của POST /api/v1/rewards/watch.
    expect(watch.match(/readRewardsToken\(/g)).toHaveLength(1);
    expect(watch).toContain('api("POST", "/api/v1/rewards/watch"');
    // token-exp.ts (#575 PR 3/3): đọc token để lấy `exp`, không gọi api, không fetch, không log.
    const exp = readFileSync(join(dir, "token-exp.ts"), "utf8");
    expect(exp).toContain("readRewardsToken(");
    expect(exp).not.toContain('"@/lib/api"');
    expect(exp).not.toMatch(/fetch\(|console\./);
  });

  it("refuses to build a rewards URL on the DeskLabs origin", () => {
    expect(() => rewardsUrl("lottery/boxes", {}, window.location.origin)).toThrow();
  });
});
