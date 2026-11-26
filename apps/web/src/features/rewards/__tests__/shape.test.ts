import { describe, expect, it } from "vitest";

import { describeShape, jwtClaimRows } from "../shape";

// Bảng hình dạng của trang chẩn đoán (#547): tên trường, kiểu, mẫu; trường nhạy cảm chỉ hiện kiểu.

const b64url = (o: unknown) =>
  btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

describe("describeShape", () => {
  it("lists paths with types and samples, merging array items", () => {
    const rows = describeShape({
      total: 2,
      boxes: [
        { tokenId: 1, level: "Common", mintedAt: 1795621043615 },
        { tokenId: 2, level: "Rare", mintedAt: null },
      ],
      rewardUsd: "5.07",
    });
    const by = Object.fromEntries(rows.map((r) => [r.path, r]));
    expect(by.total?.types).toEqual(["number (int)"]);
    expect(by.boxes?.sample).toBe("2 items");
    expect(by["boxes[].mintedAt"]?.types).toEqual(["number (int, ms timestamp?)", "null"]);
    expect(by["boxes[].level"]?.sample).toBe("Common");
    expect(by.rewardUsd?.types).toEqual(["string (decimal)"]);
  });

  it("hides values of wallet, transfer and signing fields, keeps asset contract addresses", () => {
    const rows = describeShape({
      items: [
        {
          kind: "transfer",
          from: "0x9b10000000000000000000000000000000007e21",
          to: "0x3f2a000000000000000000000000000000009c4e",
          reward: { asset: { address: "0xa72bd95411413ac31ddf61e462091f45f66c85f2" } },
        },
      ],
      accessToken: "fake-test-value",
    });
    const by = Object.fromEntries(rows.map((r) => [r.path, r]));
    expect(by["items[].from"]).toMatchObject({ hidden: true, sample: null });
    expect(by["items[].to"]).toMatchObject({ hidden: true, sample: null });
    expect(by.accessToken).toMatchObject({ hidden: true, sample: null });
    expect(by["items[].reward.asset.address"]?.hidden).toBe(false);
    expect(JSON.stringify(rows)).not.toContain("fake-test-value");
    expect(JSON.stringify(rows)).not.toContain("0x9b10");
  });

  it("groups ledger items by kind", () => {
    const rows = describeShape(
      {
        items: [
          { kind: "open", rewardUsd: "1.00" },
          { kind: "merge", result: 3 },
        ],
      },
      { groupBy: "kind" },
    );
    const paths = rows.map((r) => r.path);
    expect(paths).toContain("items[kind=open].rewardUsd");
    expect(paths).toContain("items[kind=merge].result");
  });
});

describe("jwtClaimRows", () => {
  it("shows claim names, values only for exp / iat / nbf, never the token", () => {
    const token = `${b64url({ alg: "none" })}.${b64url({ sub: "0xabc", exp: 1796000000, iat: 1795900000 })}.sig`;
    const rows = jwtClaimRows(token);
    expect(rows?.map((r) => r.path)).toEqual(["sub", "exp", "iat"]);
    expect(rows?.find((r) => r.path === "sub")).toMatchObject({ hidden: true, sample: null });
    expect(rows?.find((r) => r.path === "exp")?.sample).toContain("1796000000");
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(JSON.stringify(rows)).not.toContain("0xabc");
  });

  it("returns null for a token that is not a JWT", () => {
    expect(jwtClaimRows("opaque")).toBeNull();
    expect(jwtClaimRows(null)).toBeNull();
  });
});

describe("describeShape never shows wallet addresses (rewards-debug fix)", () => {
  // Địa chỉ giả, không phải ví của ai.
  const A1 = "0x0000000000000000000000000000000000000001";
  const A2 = "0x0000000000000000000000000000000000000002";
  const A3 = "0x0000000000000000000000000000000000000003";
  const CONTRACT = "0x00000000000000000000000000000000000000c1";
  const ASSET = "0x00000000000000000000000000000000000000a1";
  const TX = `0x${"ab".repeat(32)}`;

  it("hides walletAddress in sopoints/summary", () => {
    const rows = describeShape({ walletAddress: A1, totalPoints: 10 });
    const by = Object.fromEntries(rows.map((r) => [r.path, r]));
    expect(by.walletAddress).toMatchObject({ hidden: true, sample: null });
    expect(by.walletAddress?.types).toEqual(["string (address)"]);
    expect(by.totalPoints?.sample).toBe("10");
    expect(JSON.stringify(rows)).not.toContain(A1);
  });

  it("hides from / to of ledger transfers, feed wallets, txHash and addresses under unknown keys", () => {
    const ledger = describeShape(
      {
        items: [
          { kind: "transfer", from: A1, to: A2, txHash: TX },
          { kind: "open", note: `sent by ${A3}`, mystery: A3 },
        ],
      },
      { groupBy: "kind" },
    );
    const feed = describeShape({ items: [{ wallet: "0x05d8....389e", level: "Rare" }] });
    const bySource = describeShape({ bySource: { [A2]: 3 } });
    const all = JSON.stringify([ledger, feed, bySource]);
    for (const v of [A1, A2, A3, TX, "0x05d8"]) expect(all).not.toContain(v);
    const by = Object.fromEntries(ledger.map((r) => [r.path, r]));
    expect(by["items[kind=transfer].from"]?.hidden).toBe(true);
    expect(by["items[kind=transfer].to"]?.hidden).toBe(true);
    expect(by["items[kind=transfer].txHash"]).toMatchObject({ hidden: true, sample: null });
    expect(by["items[kind=open].mystery"]?.hidden).toBe(true);
    expect(by["items[kind=open].note"]?.hidden).toBe(true);
    expect(feed.find((r) => r.path === "items[].wallet")?.hidden).toBe(true);
    expect(feed.find((r) => r.path === "items[].level")?.sample).toBe("Rare");
    expect(bySource.map((r) => r.path)).toContain("bySource.<address>");
  });

  it("hides the row when any array item holds an address", () => {
    const rows = describeShape({ items: [{ ref: "abc" }, { ref: A1 }] });
    expect(rows.find((r) => r.path === "items[].ref")).toMatchObject({
      hidden: true,
      sample: null,
    });
  });

  it("still shows public asset and contract addresses", () => {
    const meta = describeShape({
      contracts: { treasureBox: CONTRACT },
      rewardTokens: [{ asset: { address: ASSET, symbol: "vANT" } }],
    });
    const by = Object.fromEntries(meta.map((r) => [r.path, r]));
    expect(by["contracts.treasureBox"]).toMatchObject({ hidden: false, sample: CONTRACT });
    expect(by["rewardTokens[].asset.address"]).toMatchObject({ hidden: false, sample: ASSET });
  });

  it("JWT claims: sub holding an address is hidden", () => {
    const enc = (o: unknown) =>
      btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const rows = jwtClaimRows(`${enc({ alg: "none" })}.${enc({ sub: A1, exp: 1796000000 })}.x`);
    expect(rows?.find((r) => r.path === "sub")).toMatchObject({ hidden: true, sample: null });
    expect(JSON.stringify(rows)).not.toContain(A1);
  });
});
