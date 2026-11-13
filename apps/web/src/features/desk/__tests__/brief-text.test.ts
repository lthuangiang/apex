import { describe, expect, it } from "vitest";

import { briefBody } from "../brief-text";

// Báo cáo sáng xem lúc chiều tối không được còn "Good morning" hay số câu còn lại cũ (người dùng báo trên prod 2026-11-13).
describe("briefBody", () => {
  it("drops a stored greeting and the stale questions-left line", () => {
    expect(
      briefBody(
        "Good morning. Nothing needs you today, but here's what stands out.\n\n1. X\n\nYou have 18 questions left today.",
      ),
    ).toBe("Nothing needs you today, but here's what stands out.\n\n1. X");
  });

  it("keeps the content after a greeting and a name", () => {
    expect(briefBody("Good morning, two things need you today.")).toBe(
      "Two things need you today.",
    );
    expect(briefBody("Good evening Giang, all calm.")).toBe("All calm.");
    expect(briefBody("Hello! Futures Grid paused.")).toBe("Futures Grid paused.");
  });

  it("leaves text without a greeting alone", () => {
    expect(briefBody("Goodness, ETH moved a lot.")).toBe("Goodness, ETH moved a lot.");
    expect(briefBody("Futures Grid needs you today.")).toBe("Futures Grid needs you today.");
  });

  it("never cuts a bot name or a greeting-like opening without punctuation (review #93)", () => {
    for (const t of [
      "Hi-Lo Grid paused because it hit its max loss.",
      "Hello Kitty Grid needs you today.",
      "Hey Jude DCA is running fine.",
      "Good day trading so far: nothing needs you.",
    ])
      expect(briefBody(t)).toBe(t);
    expect(briefBody("Hi there, two bots need you.")).toBe("Two bots need you.");
  });

  it("never truncates decimal amounts when dropping the questions-left sentence", () => {
    expect(briefBody("Profit was 1.5 USDC. You have 3 questions left today.")).toBe(
      "Profit was 1.5 USDC.",
    );
    expect(briefBody("Profit was 1.5 USDC and you have 3 questions left today.")).toBe(
      "Profit was 1.5 USDC and you have 3 questions left today.",
    );
    expect(briefBody("ETH Grid made 2.40 USDC; 5 questions left today, ask away.")).toBe(
      "ETH Grid made 2.40 USDC; 5 questions left today, ask away.",
    );
  });
});
