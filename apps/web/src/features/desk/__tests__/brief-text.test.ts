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
});
