import { lotterySignParamsSchema } from "@drift/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  boxTypedData,
  busyTokenIds,
  findActiveJob,
  inProgressJobId,
  pickOldest,
  postAction,
  type Authed,
} from "../actions";
import { rewardsRequest, resetRewardsRateLimit } from "../client";

import { FAKE_TOKEN, MASTER, fakeGateway } from "./gateway-fixtures";

// Logic Claim / Open / Merge (#551): box cũ trước + gửi tăng dần, typed data EIP-712, phân loại kết quả POST (không gửi lại
// khi không rõ), đối soát qua jobs?active=true. Gateway giả, token giả; không ký ví thật.

const authed: Authed = (req) => rewardsRequest({ ...req, token: FAKE_TOKEN });

afterEach(() => {
  vi.unstubAllGlobals();
  resetRewardsRateLimit();
});

const box = (tokenId: number, level: string, mintedAt: string | null) => ({
  tokenId,
  level,
  mintedAt,
});

describe("pickOldest", () => {
  it("picks oldest by mintedAt, ties by tokenId, missing mintedAt last, then sends ascending", () => {
    const boxes = [
      box(500, "Common", "2026-11-20T00:00:00Z"),
      box(100, "Common", "2026-11-25T00:00:00Z"),
      box(300, "Common", "2026-11-01T00:00:00Z"),
      box(200, "Common", "2026-11-01T00:00:00Z"),
      box(50, "Common", null),
      box(10, "Rare", "2026-10-01T00:00:00Z"),
    ];
    expect(pickOldest(boxes, "Common", 3)).toEqual([200, 300, 500]);
    expect(pickOldest(boxes, "Common", 4)).toEqual([100, 200, 300, 500]);
    expect(pickOldest(boxes, "Common", 5)).toEqual([50, 100, 200, 300, 500]);
    expect(pickOldest(boxes, "Rare", 9)).toEqual([10]);
  });

  it("skips boxes inside an unfinished job", () => {
    const boxes = [
      box(1, "Common", "2026-11-01T00:00:00Z"),
      box(2, "Common", "2026-11-02T00:00:00Z"),
      box(3, "Common", "2026-11-03T00:00:00Z"),
    ];
    const busy = busyTokenIds([
      { jobId: 1, kind: "open", status: "pending", boxes: [{ tokenId: 1 }] },
      { jobId: 2, kind: "open", status: "revealed", boxes: [{ tokenId: 2 }] },
    ]);
    expect(pickOldest(boxes, "Common", 2, busy)).toEqual([2, 3]);
  });
});

describe("boxTypedData", () => {
  it("builds RequestOpen / RequestMerge with owner, tokenIds, nonce, deadline", () => {
    const params = lotterySignParamsSchema.parse({
      chainId: 286623,
      verifyingContract: "0x00000000000000000000000000000000000000aa",
      domainName: "TreasureBox",
      domainVersion: "1",
      primaryType: "RequestMerge",
      nonce: "7",
      deadline: 1764600000,
    });
    const td = boxTypedData(params, MASTER, [3, 9]);
    expect(td.primaryType).toBe("RequestMerge");
    expect(td.types).toEqual({
      RequestMerge: [
        { name: "owner", type: "address" },
        { name: "tokenIds", type: "uint256[]" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    });
    expect(td.message).toEqual({
      owner: MASTER,
      tokenIds: [3n, 9n],
      nonce: 7n,
      deadline: 1764600000n,
    });
    expect(td.domain).toEqual({
      name: "TreasureBox",
      version: "1",
      chainId: 286623n,
      verifyingContract: "0x00000000000000000000000000000000000000aa",
    });
  });
});

describe("postAction (rule 7: never resend an unknown outcome)", () => {
  it("returns the job on success", async () => {
    const gw = fakeGateway({
      "lottery/box/open": {
        body: { code: 0, data: { jobId: 88, kind: "open", status: "submitting" } },
      },
    });
    vi.stubGlobal("fetch", gw.fn);
    expect(await postAction(authed, "lottery/box/open", { tokenIds: [1] })).toEqual({
      kind: "job",
      jobId: 88,
    });
  });

  it("network error or timeout → unknown, sent once", async () => {
    const gw = fakeGateway({ "lottery/box/open": "network" });
    vi.stubGlobal("fetch", gw.fn);
    expect(await postAction(authed, "lottery/box/open", {})).toEqual({ kind: "unknown" });
    expect(gw.calls.filter((c) => c.path === "lottery/box/open")).toHaveLength(1);

    const slow = fakeGateway({
      "lottery/box/merge": (_u, init) =>
        new Promise((_ok, fail) => {
          init?.signal?.addEventListener("abort", () => {
            fail(new DOMException("timeout", "TimeoutError"));
          });
        }),
    });
    vi.stubGlobal("fetch", slow.fn);
    expect(await postAction(authed, "lottery/box/merge", {}, 30)).toEqual({ kind: "unknown" });
    expect(slow.calls).toHaveLength(1);
  });

  it("HTTP 5xx → unknown", async () => {
    vi.stubGlobal(
      "fetch",
      fakeGateway({ "lottery/treasure/open": { status: 502, body: null } }).fn,
    );
    expect(await postAction(authed, "lottery/treasure/open", { count: 1 })).toEqual({
      kind: "unknown",
    });
  });

  it("'still in progress (job N)' → follow job N", async () => {
    vi.stubGlobal(
      "fetch",
      fakeGateway({
        "lottery/box/open": {
          body: { code: 4001, msg: "previous open still in progress (job 55)" },
        },
      }).fn,
    );
    expect(await postAction(authed, "lottery/box/open", {})).toEqual({
      kind: "already",
      jobId: 55,
    });
    expect(inProgressJobId("previous request still in progress (job #12)")).toBe(12);
    expect(inProgressJobId("signature deadline expired")).toBeNull();
  });

  it("business rejection, 401 and 429 are definite", async () => {
    vi.stubGlobal(
      "fetch",
      fakeGateway({ "lottery/box/open": { body: { code: 1, msg: "signature deadline expired" } } })
        .fn,
    );
    expect(await postAction(authed, "lottery/box/open", {})).toEqual({
      kind: "rejected",
      said: "signature deadline expired",
    });
    vi.stubGlobal("fetch", fakeGateway({ "lottery/box/open": { status: 401, body: {} } }).fn);
    expect(await postAction(authed, "lottery/box/open", {})).toEqual({ kind: "expired" });
    vi.stubGlobal(
      "fetch",
      fakeGateway({
        "lottery/box/open": { status: 429, body: { code: 429, data: { retryAfter: 5 } } },
      }).fn,
    );
    expect(await postAction(authed, "lottery/box/open", {})).toEqual({ kind: "busy" });
  });
});

describe("findActiveJob", () => {
  it("returns the newest unfinished job of the same kind", async () => {
    const gw = fakeGateway({
      "lottery/jobs": {
        body: {
          code: 0,
          data: {
            jobs: [
              { jobId: 70, kind: "open", status: "pending" },
              { jobId: 77, kind: "open", status: "submitting" },
              { jobId: 90, kind: "merge", status: "pending" },
            ],
          },
        },
      },
    });
    vi.stubGlobal("fetch", gw.fn);
    expect(await findActiveJob(authed, "open")).toBe(77);
    expect(await findActiveJob(authed, "merge")).toBe(90);
    expect(await findActiveJob(authed, "claim")).toBeNull();
    expect(gw.calls.every((c) => c.url.includes("active=true"))).toBe(true);
  });
});
