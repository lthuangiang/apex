import { describe, expect, it } from "vitest";

import messages from "../../../../messages/en.json";
import { redirectFor } from "../../../proxy";
import { FIELDS } from "../../bots/fields";
import { deviceLabel } from "../../settings/device-label";
import { assetLinks } from "../asset-links";
import { LANDING_STRATEGIES, strategiesFor } from "../strategies";

describe("public pages (UI_REVIEW K, L)", () => {
  it("lets signed-out visitors see the landing and the risk disclosure", () => {
    expect(redirectFor("/", false)).toBeNull();
    expect(redirectFor("/risk-disclosure", false)).toBeNull();
    expect(redirectFor("/risk-disclosure", true)).toBeNull();
    expect(redirectFor("/", true)).toBeNull();
    // App Android (TWA) đọc hai file này khi chưa đăng nhập.
    expect(redirectFor("/manifest.webmanifest", false)).toBeNull();
    expect(redirectFor("/.well-known/assetlinks.json", false)).toBeNull();
  });

  it("sends the OAuth consent page through sign-in and back, keeping its parameters (MCP)", () => {
    const q = "?client_id=abc&state=x";
    expect(redirectFor("/oauth/authorize", false, q)).toBe(
      `/signin?next=${encodeURIComponent(`/oauth/authorize${q}`)}`,
    );
    expect(redirectFor("/oauth/authorize", true, q)).toBeNull();
    expect(
      redirectFor("/signin", true, `?next=${encodeURIComponent("/oauth/authorize?a=1")}`),
    ).toBe("/oauth/authorize?a=1");
    // Không bao giờ chuyển ra ngoài.
    expect(redirectFor("/signin", true, "?next=%2F%2Fevil.example")).toBe("/");
    expect(redirectFor("/.well-known/oauth-authorization-server", false)).toBeNull();
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

describe("assetlinks.json", () => {
  const sha = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, "0")).join(":");

  it("is empty until the package and a valid fingerprint are set", () => {
    expect(assetLinks({})).toEqual([]);
    expect(assetLinks({ ANDROID_PACKAGE_NAME: "com.drift.app" })).toEqual([]);
    expect(
      assetLinks({ ANDROID_PACKAGE_NAME: "com.drift.app", ANDROID_CERT_SHA256: "AB:CD" }),
    ).toEqual([]);
    expect(assetLinks({ ANDROID_PACKAGE_NAME: "nodots", ANDROID_CERT_SHA256: sha })).toEqual([]);
  });

  it("delegates all URLs to the app, with every fingerprint upper-cased", () => {
    expect(
      assetLinks({
        ANDROID_PACKAGE_NAME: "com.drift.app",
        ANDROID_CERT_SHA256: `${sha}, ${sha.toUpperCase()}`,
      }),
    ).toEqual([
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: "com.drift.app",
          sha256_cert_fingerprints: [sha.toUpperCase(), sha.toUpperCase()],
        },
      },
    ]);
  });
});

describe("strategy catalog copy", () => {
  it("has every card text for every strategy, volume bots included", () => {
    for (const key of Object.keys(FIELDS)) {
      for (const group of ["groups", "long", "fits", "risks"] as const) {
        expect(messages.bots[group], `bots.${group}.${key}`).toHaveProperty(key);
      }
    }
  });
});

describe("deviceLabel", () => {
  it("names common browsers and keeps what it can't recognise", () => {
    expect(
      deviceLabel(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
      ),
    ).toBe("Chrome on macOS");
    expect(deviceLabel("curl/8.0")).toBe("curl/8.0");
    expect(deviceLabel(null)).toBeNull();
  });
});
