import {
  lotteryBoxesSchema,
  sopointsVolumeWeightsSchema,
  SODEX_REWARDS_DEFAULT_ORIGIN,
} from "@drift/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  RATE_LIMIT_FALLBACK_SEC,
  RewardsError,
  rewardsPausedUntil,
  rewardsPauseKnown,
  rewardsRequest,
  rewardsUrl,
  resetRewardsRateLimit,
} from "../client";
import { rewardsGatewayOrigin } from "../gateway";

import { urlOf } from "./fetch-helpers";

// Client Rewards API (#547): envelope, zod, 401, 429 + retryAfter. Token trong test là chuỗi giả, không phải JWT thật.

const ORIGIN = SODEX_REWARDS_DEFAULT_ORIGIN;
const FAKE = "fake-test-value";

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.fn<typeof fetch>(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json", ...headers },
      }),
    ),
  );
}

const boxes = {
  total: 2,
  maxPerOpen: 30,
  byLevel: [{ level: "Common", count: 2, mergeSize: 10, canMergeNow: false, mergesAvailable: 0 }],
  boxes: [
    { tokenId: 201640, level: "Common", source: "trade", mintedAt: 1795621043615 },
    { tokenId: 201641, level: "Common", source: "trade", mintedAt: 1795621043615 },
  ],
};

afterEach(() => {
  resetRewardsRateLimit();
});

async function caught(p: Promise<unknown>): Promise<RewardsError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RewardsError) return e;
    throw e;
  }
  throw new Error("expected a RewardsError");
}

describe("rewardsRequest", () => {
  it("parses data when code is 0 and sends the token only as a bearer header, without cookies", async () => {
    const f = respond(200, { code: 0, msg: "success", data: boxes });
    const out = await rewardsRequest({
      path: "lottery/boxes",
      token: FAKE,
      schema: lotteryBoxesSchema,
      fetchImpl: f,
    });
    expect(out.boxes.map((b) => b.tokenId)).toEqual([201640, 201641]);
    const [url, init] = f.mock.calls[0] ?? [];
    expect(urlOf(url)).toBe(`${ORIGIN}/api/v1/lottery/boxes`);
    expect(urlOf(url)).not.toContain(FAKE);
    expect(init?.credentials).toBe("omit");
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${FAKE}`);
  });

  it("omits Authorization on public reads", async () => {
    const f = respond(200, { code: 0, msg: "success", data: { ok: true } });
    await rewardsRequest({ path: "lottery/meta", schema: z.unknown(), fetchImpl: f });
    const init = f.mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("fails with schema when data does not match, listing only field paths", async () => {
    const f = respond(200, { code: 0, msg: "success", data: { ...boxes, total: "two" } });
    const e = await caught(
      rewardsRequest({
        path: "lottery/boxes",
        token: FAKE,
        schema: lotteryBoxesSchema,
        fetchImpl: f,
      }),
    );
    expect(e.kind).toBe("schema");
    expect(e.issues).toEqual(["total"]);
    expect(e.message).not.toContain(FAKE);
  });

  it("reads a business error from msg or from message (volume-weights)", async () => {
    const withMsg = await caught(
      rewardsRequest({
        path: "lottery/treasure/open",
        method: "POST",
        body: { count: 1 },
        token: FAKE,
        schema: z.unknown(),
        fetchImpl: respond(200, { code: -1, msg: "no treasure available" }),
      }),
    );
    expect(withMsg.kind).toBe("business");
    expect(withMsg.sodexMessage).toBe("no treasure available");

    const withMessage = await caught(
      rewardsRequest({
        path: "sopoints/volume-weights",
        schema: sopointsVolumeWeightsSchema,
        fetchImpl: respond(200, { code: 500, message: "round not found" }),
      }),
    );
    expect(withMessage.kind).toBe("business");
    expect(withMessage.sodexMessage).toBe("round not found");
  });

  it("accepts the volume-weights envelope with message and empty text", async () => {
    const data = {
      activity_id: 6,
      round: { round_id: 13, start_ts_ms: 1795521600000, end_ts_ms: 1796126400000 },
      weights: [{ market_type: "perps", symbol_id: 54, symbol: "NVDA-USD", coefficient: "1.2" }],
    };
    const out = await rewardsRequest({
      path: "sopoints/volume-weights",
      schema: sopointsVolumeWeightsSchema,
      fetchImpl: respond(200, { code: 0, message: "", data }),
    });
    expect(out.weights[0]?.coefficient).toBe("1.2");
  });

  it("maps HTTP 401 to expired", async () => {
    const e = await caught(
      rewardsRequest({
        path: "sopoints/summary",
        token: FAKE,
        schema: z.unknown(),
        fetchImpl: respond(401, { code: 401, msg: "unauthorized" }),
      }),
    );
    expect(e.kind).toBe("expired");
    expect(e.status).toBe(401);
  });

  it("maps HTTP 429 to rate_limited with data.retryAfter and stops later requests until it passes", async () => {
    let now = 1_000_000;
    const clock = () => now;
    const f = respond(429, { code: 429, msg: "too many requests", data: { retryAfter: 42 } });
    const e = await caught(
      rewardsRequest({
        path: "lottery/boxes",
        token: FAKE,
        schema: z.unknown(),
        fetchImpl: f,
        now: clock,
      }),
    );
    expect(e.kind).toBe("rate_limited");
    expect(e.retryAfterSec).toBe(42);
    expect(rewardsPausedUntil()).toBe(1_000_000 + 42_000);

    // Trong lúc dừng: không gửi request nào.
    const ok = respond(200, { code: 0, msg: "success", data: {} });
    now += 10_000;
    const paused = await caught(
      rewardsRequest({
        path: "lottery/boxes",
        token: FAKE,
        schema: z.unknown(),
        fetchImpl: ok,
        now: clock,
      }),
    );
    expect(paused.kind).toBe("rate_limited");
    expect(paused.retryAfterSec).toBe(32);
    expect(ok).not.toHaveBeenCalled();

    // Hết hạn: gửi lại bình thường.
    now += 33_000;
    await rewardsRequest({ path: "lottery/boxes", schema: z.unknown(), fetchImpl: ok, now: clock });
    expect(ok).toHaveBeenCalledTimes(1);
    expect(rewardsPausedUntil()).toBeNull();
  });

  it("429 without retryAfter: retryAfter stays unknown, polling still pauses", async () => {
    const e = await caught(
      rewardsRequest({
        path: "lottery/feed",
        schema: z.unknown(),
        fetchImpl: respond(429, { code: 429, msg: "busy" }),
        now: () => 0,
      }),
    );
    expect(e.retryAfterSec).toBeNull();
    expect(rewardsPausedUntil()).toBe(RATE_LIMIT_FALLBACK_SEC * 1000);
    expect(rewardsPauseKnown()).toBe(false);
    // #548: các request bị chặn trong lúc dừng cũng không lộ số giây dự phòng (UI không đếm ngược).
    const later = await caught(
      rewardsRequest({ path: "lottery/feed", schema: z.unknown(), now: () => 10_000 }),
    );
    expect(later.kind).toBe("rate_limited");
    expect(later.retryAfterSec).toBeNull();
  });

  it("maps fetch failures to network and other HTTP errors to http", async () => {
    const down = vi.fn<typeof fetch>(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(
      (await caught(rewardsRequest({ path: "lottery/meta", schema: z.unknown(), fetchImpl: down })))
        .kind,
    ).toBe("network");
    const e = await caught(
      rewardsRequest({ path: "lottery/meta", schema: z.unknown(), fetchImpl: respond(502, null) }),
    );
    expect(e.kind).toBe("http");
    expect(e.status).toBe(502);
  });

  it("reads cybereator without an envelope", async () => {
    const out = await rewardsRequest({
      path: "cybereator/profile/1874",
      envelope: false,
      schema: z.object({ id: z.number(), stage: z.string() }),
      fetchImpl: respond(200, { id: 1874, stage: "unopened" }),
    });
    expect(out.stage).toBe("unopened");
  });
});

describe("rewardsUrl / gateway", () => {
  it("refuses odd paths and anything outside the gateway", () => {
    expect(() => rewardsUrl("../auth/nonce")).toThrow();
    expect(() => rewardsUrl("//evil.example/x")).toThrow();
    expect(() => rewardsUrl("https://evil.example/x")).toThrow();
    expect(rewardsUrl("lottery/jobs", { active: true }).toString()).toBe(
      `${ORIGIN}/api/v1/lottery/jobs?active=true`,
    );
  });

  it("uses the mainnet gateway unless a valid https origin is set", () => {
    expect(rewardsGatewayOrigin(undefined)).toBe(ORIGIN);
    expect(rewardsGatewayOrigin("")).toBe(ORIGIN);
    expect(rewardsGatewayOrigin("http://insecure.example")).toBe(ORIGIN);
    expect(rewardsGatewayOrigin("not a url")).toBe(ORIGIN);
    expect(rewardsGatewayOrigin("https://gw.example/api/v1")).toBe("https://gw.example");
  });
});
