import { describe, expect, it } from "vitest";

import { emailText } from "../src/notify";
import { renderTelegram } from "../src/telegram-render";

// #594 (DEC-404): tin Telegram / email của nhóm `wealth`. Mẫu tin còn chờ PM duyệt (`_pendingReview` của jobs), nên test
// kiểm cấu trúc và dữ liệu (tên quỹ, số tiền đúng như SoDEX trả, nút), không kiểm nguyên câu. Không bao giờ có địa chỉ
// ví, không có % hay số bịa.

const APP = "https://desklabs.test";
const one = (
  type: Parameters<typeof renderTelegram>[0][number]["type"],
  data: Record<string, unknown>,
) => renderTelegram([{ type, data, botName: null }], APP);

const settled = (over: Record<string, unknown> = {}) => ({
  fundId: "fund-a",
  fundName: "Sample Fund A",
  what: "invest",
  status: "completed",
  cost: "1500.500000",
  proceeds: null,
  shares: "14.250000",
  ...over,
});
const skipped = (over: Record<string, unknown> = {}) => ({
  fundId: "fund-a",
  fundName: "Sample Fund A",
  status: "skipped",
  reasonCode: null,
  scheduledDate: "2026-11-28",
  amount: "25",
  ...over,
});

describe("wealth Telegram messages", () => {
  it("settled request: fund name, the SoDEX amount unrounded, Open My Wealth", () => {
    const m = one("wealth_request_settled", settled());
    expect(m.text).toContain("Sample Fund A");
    expect(m.text).toContain("1,500.50");
    expect(m.text).toContain("14.25");
    expect(m.button).toEqual({ text: "Open My Wealth", url: `${APP}/portfolio?tab=wealth` });
    expect(one("wealth_request_settled", settled({ cost: "0.123456" })).text).toContain("0.123456");
  });

  it("each type and status reads differently; redeem shows shares and proceeds", () => {
    const texts = new Set(
      ["completed", "failed", "rejected", "cancelled"].flatMap((status) =>
        ["invest", "redeem", "recurring_buy"].map(
          (what) => one("wealth_request_settled", settled({ status, what })).text.split("\n")[0],
        ),
      ),
    );
    expect(texts.size).toBe(12);
    const redeem = one(
      "wealth_request_settled",
      settled({ what: "redeem", cost: null, shares: "10", proceeds: "1020.4" }),
    ).text;
    expect(redeem).toContain("10.00");
    expect(redeem).toContain("1,020.40");
  });

  it("missing numbers are left out, never shown as 0", () => {
    const m = one(
      "wealth_request_settled",
      settled({ cost: null, shares: null, status: "failed" }),
    );
    expect(m.text).not.toMatch(/\b0(\.0+)?\b/);
    expect(m.text).not.toContain("$");
  });

  it("escapes the fund name and falls back to the fund id", () => {
    expect(one("wealth_request_settled", settled({ fundName: "<b>x" })).text).toContain(
      "&lt;b&gt;x",
    );
    expect(one("wealth_request_settled", settled({ fundName: null })).text).toContain("fund-a");
  });

  it("recurring buy skipped / failed: fund, date, amount", () => {
    const m = one("wealth_recurring_issue", skipped());
    expect(m.text).toContain("Sample Fund A");
    expect(m.text).toContain("2026-11-28");
    expect(m.text).toContain("25.00");
    expect(m.button.url).toBe(`${APP}/portfolio?tab=wealth`);
    expect(
      one("wealth_recurring_issue", skipped({ status: "failed" })).text.split("\n")[0],
    ).not.toBe(m.text.split("\n")[0]);
  });

  it("no percentage, no wallet address, no advice in any message", () => {
    const all = [
      one("wealth_request_settled", settled()),
      one("wealth_request_settled", settled({ what: "redeem", proceeds: "99" })),
      one("wealth_recurring_issue", skipped()),
      one("wealth_request_settled", {}),
    ].map((m) => m.text);
    for (const t of all) {
      expect(t).not.toContain("%");
      expect(t).not.toMatch(/0x[0-9a-fA-F]{8,}/);
      expect(t.toLowerCase()).not.toMatch(/\b(should|recommend|profit|return)\b/);
    }
  });

  it("several wealth alerts merged in one message open My Wealth", () => {
    const m = renderTelegram(
      [
        { type: "wealth_request_settled", data: settled(), botName: null },
        { type: "wealth_recurring_issue", data: skipped(), botName: null },
      ],
      APP,
    );
    expect(m.button.url).toBe(`${APP}/portfolio?tab=wealth`);
    expect(m.text).not.toContain("%");
  });

  it("email has a short line only", () => {
    const e = emailText("wealth_request_settled", settled(), null);
    expect(e.subject).toContain("SoDEX Wealth");
    expect(e.text).not.toContain("%");
  });
});
