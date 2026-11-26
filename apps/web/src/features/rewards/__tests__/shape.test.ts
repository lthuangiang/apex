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
