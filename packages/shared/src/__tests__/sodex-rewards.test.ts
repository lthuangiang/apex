import { describe, expect, it } from "vitest";

import {
  cybereatorProfileSchema,
  lotteryFeedSchema,
  lotteryMetaSchema,
  rewardsEnvelopeSchema,
  sameWallet,
  sopointsVolumeWeightsSchema,
  sopointsWeekInfoSchema,
} from "../sodex-rewards";

// Schema Rewards API (#547) khớp response công khai thật của gateway mainnet (lấy 2026-11-26, cắt bớt). Endpoint cần
// JWT chưa có mẫu thật: trang chẩn đoán team đọc và báo lệch.

describe("SoDEX rewards public responses", () => {
  it("week/info and volume-weights (envelope with msg / with message)", () => {
    const info = rewardsEnvelopeSchema.parse({
      code: 0,
      msg: "success",
      data: {
        weekNo: 13,
        weekName: "Week 13",
        weekStatus: "LIVE",
        weekPoolPoints: 1000000,
        nextWeekStartTime: 1796126400,
        distributionTime: 1796385600,
      },
    });
    expect(sopointsWeekInfoSchema.parse(info.data).weekNo).toBe(13);
    const vw = rewardsEnvelopeSchema.parse({
      code: 0,
      message: "",
      data: {
        activity_id: 6,
        round: { round_id: 13, start_ts_ms: 1795521600000, end_ts_ms: 1796126400000 },
        weights: [{ market_type: "perps", symbol_id: 54, symbol: "NVDA-USD", coefficient: "1.2" }],
      },
    });
    expect(vw.message).toBe("");
    expect(sopointsVolumeWeightsSchema.parse(vw.data).round.round_id).toBe(13);
  });

  it("lottery/meta, lottery/feed and a cybereator profile", () => {
    const meta = lotteryMetaSchema.parse({
      rewardTokens: [
        {
          asset: {
            address: "0xa72bd95411413ac31ddf61e462091f45f66c85f2",
            symbol: "vANT",
            decimals: 8,
          },
          priceUsd: "82.79",
          destination: "spot",
        },
      ],
      rules: {
        mergeSize: { Common: 10, Rare: 4, SuperRare: 0, Uncommon: 10 },
        limits: { maxTreasureOpen: 100, maxBoxOpen: 30 },
      },
    });
    expect(meta.rules.limits.maxBoxOpen).toBe(30);
    const feed = lotteryFeedSchema.parse({
      minLevel: "Common",
      items: [
        {
          kind: "open",
          tsMs: 1795621043615,
          wallet: "0x05d8....389e",
          level: "Uncommon",
          tokenId: 196519,
          rewardUsd: "10.55",
          reward: {
            asset: {
              address: "0xa72bd95411413ac31ddf61e462091f45f66c85f2",
              symbol: "vANT",
              decimals: 8,
            },
            amount: "0.09461883",
            amountRaw: "9461883",
          },
          pfp: true,
        },
      ],
    });
    expect(feed.items[0]?.pfp).toBe(true);
    expect(
      cybereatorProfileSchema.parse({
        id: 1874,
        stage: "unopened",
        openBlock: null,
        image: null,
        thumb: null,
        rarity: null,
      }).stage,
    ).toBe("unopened");
  });

  it("rejects an envelope without a numeric code", () => {
    expect(rewardsEnvelopeSchema.safeParse({ msg: "x" }).success).toBe(false);
  });
});

describe("sameWallet", () => {
  it("compares addresses case-insensitively and refuses non-addresses", () => {
    const a = "0x3f2a000000000000000000000000000000009c4e";
    expect(sameWallet(a, a.toUpperCase().replace("0X", "0x"))).toBe(true);
    expect(sameWallet(a, "0x71b00000000000000000000000000000000022d1")).toBe(false);
    expect(sameWallet(a, null)).toBe(false);
    expect(sameWallet("abc", "abc")).toBe(false);
  });
});
