import { describe, expect, it } from "vitest";

import messages from "../../../../messages/en.json";
import { redirectFor } from "../../../proxy";
import { LANDING_STRATEGIES, strategiesFor } from "../strategies";

describe("public pages (UI_REVIEW K, L)", () => {
  it("lets signed-out visitors see the landing and the risk disclosure", () => {
    expect(redirectFor("/", false)).toBeNull();
    expect(redirectFor("/risk-disclosure", false)).toBeNull();
    expect(redirectFor("/risk-disclosure", true)).toBeNull();
    expect(redirectFor("/", true)).toBeNull();
  });

  it("keeps every other page behind a session", () => {
    expect(redirectFor("/bots", false)).toBe("/signup");
    expect(redirectFor("/risk", false)).toBe("/signup");
    expect(redirectFor("/signup", false)).toBeNull();
    expect(redirectFor("/signup", true)).toBe("/");
    expect(redirectFor("/signin", true)).toBe("/");
  });

  it("lists the 8 catalog strategies without Volume Maker, filtered by engine", () => {
    expect(strategiesFor("all")).toHaveLength(8);
    expect(strategiesFor("all")).not.toContain("volume_maker");
    expect(strategiesFor("spot")).toEqual([
      "spot_grid",
      "spot_dca",
      "recurring_buy",
      "rebalancing",
      "funding_arb",
      "twap",
    ]);
    expect(strategiesFor("perps")).toEqual(["futures_grid", "futures_dca", "funding_arb", "twap"]);
  });

  it("has copy for every strategy card", () => {
    const s = messages.createBot.strategies as Record<string, Record<string, string>>;
    for (const { key } of LANDING_STRATEGIES) {
      for (const field of ["name", "engine", "what", "short"]) expect(s[key]?.[field]).toBeTruthy();
    }
  });

  it("never mentions Terms or the old 0.05% fee on public copy", () => {
    const text = JSON.stringify([
      messages.landing,
      messages.riskDisclosure,
      messages.onboarding.signup,
    ]);
    expect(text).not.toMatch(/\bTerms\b/);
    expect(text).not.toContain("0.05%");
    expect(text).not.toMatch(/\[[A-Z ]+\]/);
  });
});

describe("CSP for WalletConnect", () => {
  it("allows the wallet list and logos only when a Project ID is set", async () => {
    const { buildCsp } = await import("../../../proxy");
    const on = buildCsp("n", false, true);
    expect(on).toMatch(/connect-src[^;]*https:\/\/\*\.web3modal\.org/);
    expect(on).toMatch(/img-src[^;]*https:\/\/\*\.web3modal\.org/);
    expect(buildCsp("n", false, false)).not.toContain("web3modal");
  });
});
