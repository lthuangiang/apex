import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";

import messages from "../../../../messages/en.json";
import {
  buildReport,
  formatCappedCount,
  formatRate,
  localTime,
  maskAddress,
  maskAddressesIn,
  prettyJson,
  reportSubject,
  utcOffsetLabel,
  utcTime,
} from "../format";

import { ADDRESS, DETAIL, PLACE } from "./fixtures";

const tr = createTranslator({ locale: "en", messages });
const t = (k: string, v?: Record<string, string | number>) =>
  tr(`sodexDebugger.reportText.${k}` as never, v as never);

describe("SoDEX Debugger format helpers", () => {
  it("formats UTC and local times", () => {
    expect(utcTime("2026-11-17T15:05:12.481Z")).toBe("15:05:12.481");
    expect(utcTime("2026-11-17T15:05:12.481Z", false)).toBe("15:05:12");
    expect(localTime("2026-11-17T15:05:12.481Z", "Asia/Ho_Chi_Minh")).toBe("22:05:12");
    expect(utcOffsetLabel(420)).toBe("UTC+7");
    expect(utcOffsetLabel(-210)).toBe("UTC-3:30");
    expect(utcOffsetLabel(0)).toBe("UTC");
  });

  it("masks addresses and computes the error rate from real counts only", () => {
    expect(maskAddress(ADDRESS)).toBe("0x4E1e…29Db");
    expect(maskAddressesIn(`/perps/accounts/${ADDRESS}/orders`)).toBe(
      "/perps/accounts/0x4E1e…29Db/orders",
    );
    expect(formatRate(620, 182406)).toBe("0.34%");
    expect(formatRate(0, 0)).toBeNull();
  });

  it("names the report subject from the endpoint", () => {
    expect(reportSubject(DETAIL).key).toBe("cancel");
    expect(reportSubject(PLACE).key).toBe("newOrder");
    expect(reportSubject({ kind: "ws", method: "SUB", endpoint: "accountTrade" }).key).toBe("ws");
    expect(
      reportSubject({ kind: "rest", method: "POST", endpoint: "/perps/trade/leverage" }).key,
    ).toBe("leverage");
  });

  it("builds the plain-text report like the design", () => {
    const text = buildReport(
      DETAIL,
      { related: true, fullAddress: true, responseHeaders: false },
      t,
    );
    expect(text.split("\n")[0]).toBe("SoDEX API issue: cancel answered with an unreadable result");
    expect(text).toContain("Time (UTC):   2026-11-17 15:05:12.481");
    expect(text).toContain(
      "Endpoint:     DELETE https://mainnet-gw.sodex.dev/api/v1/perps/trade/orders",
    );
    expect(text).toContain(`Account:      ${ADDRESS} (accountID 20417)`);
    expect(text).toContain("Builder:      DeskLabs (builder ID 1645)");
    expect(text).toContain("WS connID:    ws-perps-3f8a");
    expect(text).toContain("Request (signature and API key removed)");
    expect(text).toContain("Headers: Content-Type: application/json; X-API-Nonce: 1763391912468");
    expect(text).not.toContain("X-API-Sign");
    expect(text).not.toContain("X-API-Key");
    expect(text).toContain("Response (HTTP 200)");
    expect(text).toContain(
      '{"code": 0, "clOrdID": "drift-b31-v4-cx-88213"} or a reject with clOrdID.',
    );
    expect(text).toContain("Related call\n15:05:11.902 UTC  POST /perps/trade/orders");
    expect(text.endsWith("Sent from DeskLabs SoDEX Debugger")).toBe(true);
  });

  it("masks the address and drops optional parts when unchecked", () => {
    const text = buildReport(
      { ...DETAIL, builderId: null },
      { related: false, fullAddress: false, responseHeaders: true },
      t,
    );
    expect(text).not.toContain(ADDRESS);
    expect(text).toContain("Account:      0x4E1e…29Db (accountID 20417)");
    expect(text).not.toContain("Builder:");
    expect(text).not.toContain("Related call");
    expect(text).toContain("Response headers\ncontent-type: application/json");
  });
});

describe("SoDEX Debugger body and count formatting (review PR #217)", () => {
  it("indents JSON without parsing it, keeping uint64 digits and truncated bodies", () => {
    expect(
      prettyJson('{"code":0,"data":[{"orderID":18446744073709551615,"s":"a,{b"}],"e":[]}'),
    ).toBe(
      '{\n  "code": 0,\n  "data": [\n    {\n      "orderID": 18446744073709551615,\n      "s": "a,{b"\n    }\n  ],\n  "e": []\n}',
    );
    expect(prettyJson('{"a":[1,2')).toBe('{\n  "a": [\n    1,\n    2');
    expect(prettyJson("<html>")).toBe("<html>");
  });

  it("shows 1,000+ for capped outcome counts", () => {
    expect(formatCappedCount(1001)).toBe("1,000+");
    expect(formatCappedCount(1000)).toBe("1,000");
    expect(formatCappedCount(7)).toBe("7");
  });
});
