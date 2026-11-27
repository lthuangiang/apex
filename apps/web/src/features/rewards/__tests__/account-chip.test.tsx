// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { AccountChip } from "../components/rewards-page";
import { rewardsExpiryMs } from "../token-exp";
import { clearAllRewardsTokens, saveRewardsToken } from "../token-store";

import { MASTER } from "./gateway-fixtures";

// Chip tài khoản rewards ở hàng tiêu đề (#575 PR 3/3, bản phác polish 03): menu Rewards sign-in · Signed in as · Expires
// (claim `exp` của JWT, đọc tại trình duyệt) · Sign out of rewards; aria-expanded, Esc, focus, bấm ra ngoài.

// JWT giả (không chữ ký thật): payload {"exp": 1796972520} = 2026-12-11 07:02 UTC.
const WITH_EXP = "h.eyJleHAiOiAxNzk2OTcyNTIwLCAic3ViIjogIngifQ.s";
const NO_EXP = "h.eyJzdWIiOiAieCJ9.s";

afterEach(() => {
  cleanup();
  clearAllRewardsTokens();
});

function show(onSignOut = vi.fn()) {
  const view = render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <p>outside</p>
      <AccountChip master={MASTER} tz="UTC" onSignOut={onSignOut} />
    </NextIntlClientProvider>,
  );
  return { ...view, onSignOut };
}

describe("rewardsExpiryMs", () => {
  it("reads exp (seconds) from the stored JWT; missing or malformed → null", () => {
    expect(rewardsExpiryMs(MASTER)).toBeNull();
    saveRewardsToken(MASTER, WITH_EXP);
    expect(rewardsExpiryMs(MASTER)).toBe(1796972520 * 1000);
    saveRewardsToken(MASTER, NO_EXP);
    expect(rewardsExpiryMs(MASTER)).toBeNull();
    saveRewardsToken(MASTER, "not-a-jwt");
    expect(rewardsExpiryMs(MASTER)).toBeNull();
    saveRewardsToken(MASTER, "h.%%%.s");
    expect(rewardsExpiryMs(MASTER)).toBeNull();
  });
});

describe("AccountChip", () => {
  it("opens and closes the menu; shows Rewards sign-in, Signed in as and Expires from exp", async () => {
    saveRewardsToken(MASTER, WITH_EXP);
    const user = userEvent.setup();
    show();
    const chip = screen.getByRole("button", { name: /Rewards sign-in/ });
    expect(chip).toHaveAttribute("aria-expanded", "false");
    expect(chip).toHaveTextContent("0x3f2a…9c4e");
    expect(screen.queryByRole("button", { name: "Sign out of rewards" })).toBeNull();

    await user.click(chip);
    expect(chip).toHaveAttribute("aria-expanded", "true");
    const menu = document.getElementById(chip.getAttribute("aria-controls") ?? "");
    expect(menu).not.toBeNull();
    expect(menu).toBeVisible();
    expect(screen.getByText("Rewards sign-in")).toBeVisible();
    expect(screen.getByText("Signed in as 0x3f2a…9c4e")).toBeVisible();
    expect(screen.getByText("Expires Dec 11")).toBeVisible();
    // Mở thì focus vào mục đầu tiên của menu.
    expect(screen.getByRole("button", { name: "Sign out of rewards" })).toHaveFocus();

    await user.click(chip);
    expect(chip).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Sign out of rewards" })).toBeNull();
  });

  it("Esc closes and returns focus to the chip; clicking outside closes", async () => {
    saveRewardsToken(MASTER, WITH_EXP);
    const user = userEvent.setup();
    show();
    const chip = screen.getByRole("button", { name: /Rewards sign-in/ });
    await user.click(chip);
    await user.keyboard("{Escape}");
    expect(chip).toHaveAttribute("aria-expanded", "false");
    expect(chip).toHaveFocus();

    await user.click(chip);
    expect(chip).toHaveAttribute("aria-expanded", "true");
    await user.click(screen.getByText("outside"));
    expect(chip).toHaveAttribute("aria-expanded", "false");
  });

  it("no exp claim → no Expires line", async () => {
    saveRewardsToken(MASTER, NO_EXP);
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole("button", { name: /Rewards sign-in/ }));
    expect(screen.getByText("Signed in as 0x3f2a…9c4e")).toBeVisible();
    expect(screen.queryByText(/^Expires/)).toBeNull();
  });

  it("Sign out of rewards calls the sign-out handler once and closes the menu", async () => {
    saveRewardsToken(MASTER, WITH_EXP);
    const user = userEvent.setup();
    const { onSignOut } = show();
    await user.click(screen.getByRole("button", { name: /Rewards sign-in/ }));
    await user.click(screen.getByRole("button", { name: "Sign out of rewards" }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /Rewards sign-in/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("passes axe closed and open", async () => {
    saveRewardsToken(MASTER, WITH_EXP);
    const user = userEvent.setup();
    const { container } = show();
    expect((await axe.run(container)).violations).toEqual([]);
    await user.click(screen.getByRole("button", { name: /Rewards sign-in/ }));
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
