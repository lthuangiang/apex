import { describe, expect, it } from "vitest";

import { emailText } from "../src/notify";
import { subjectFor, TELEGRAM_SUBJECT } from "../src/telegram";
import { renderTelegram } from "../src/telegram-render";

// Tin bậc builder fee Market Making đổi (DEC-258, DEC-TBD-mm-fee-card; câu duyệt 2026-11-16). Không cần Postgres.

const APP = "https://desklabs.test";
const lowered = {
  strategy: "volume_maker",
  rate: 2,
  previousRate: 3,
  volume: "250000.9",
  droppedBelow: null,
};
const raised = {
  strategy: "volume_maker",
  rate: 2,
  previousRate: 1,
  volume: "999999.99",
  droppedBelow: "1000000",
};
const tg = (data: Record<string, unknown>) =>
  renderTelegram([{ type: "fee_tier_changed", data, botName: null }], APP);

describe("fee_tier_changed on Telegram", () => {
  it("rate lowered: says the volume reached, rounded down, and opens Settings › SoDEX access", () => {
    const m = tg(lowered);
    expect(m.text).toBe(
      "🔑 <b>Market Making fee lowered to 0.002%</b>\nYour Market Making volume in the last 30 days reached 250,000 USDC. New orders pay 0.002% instead of 0.003%.",
    );
    expect(m.button).toEqual({ text: "Open Settings", url: `${APP}/settings?tab=access` });
  });

  it("rate back up: says the volume fell below the tier it left, never rounding up", () => {
    expect(tg(raised).text).toBe(
      "🔑 <b>Market Making fee back to 0.002%</b>\nYour Market Making volume in the last 30 days fell to 999,999 USDC, below 1,000,000 USDC. New orders pay 0.002% instead of 0.001%.",
    );
  });

  it("without a volume only states the rates (no invented number)", () => {
    expect(tg({ ...lowered, volume: null }).text).toBe(
      "🔑 <b>Market Making fee lowered to 0.002%</b>\nNew orders pay 0.002% instead of 0.003%.",
    );
    expect(tg({ ...raised, droppedBelow: null }).text).toBe(
      "🔑 <b>Market Making fee back to 0.002%</b>\nNew orders pay 0.002% instead of 0.001%.",
    );
  });

  it("a malformed payload gets the group title and no numbers", () => {
    expect(tg({ rate: "2" }).text).toBe("🔑 <b>SoDEX access changed</b>");
  });

  it("goes through the normal queue, not the bot-problems queue", () => {
    expect(subjectFor("fee_tier_changed")).toBe(TELEGRAM_SUBJECT);
  });
});

describe("fee_tier_changed by email", () => {
  it("uses the same title and sentence without emoji or HTML", () => {
    expect(emailText("fee_tier_changed", lowered, null)).toEqual({
      subject: "DeskLabs: Market Making fee lowered to 0.002%",
      text: "Your Market Making volume in the last 30 days reached 250,000 USDC. New orders pay 0.002% instead of 0.003%.",
    });
    expect(emailText("fee_tier_changed", raised, null).subject).toBe(
      "DeskLabs: Market Making fee back to 0.002%",
    );
  });
});
