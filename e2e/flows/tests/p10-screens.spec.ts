import { expect, test } from "@playwright/test";

import { signUpConnectAnd2fa } from "../support/onboard";
import { nextTotpWindow, totp } from "../support/totp";

// Tiêu chí P10 (docs/ROADMAP.md): Overview, Portfolio, Risk Center, AI Analyst, Notifications, Builder Revenue
// hiện số khớp API (mock SoDEX: 100,000 vUSDC Spot + Perps account value 100,000), đủ trạng thái rỗng / có dữ liệu.

test("overview, portfolio, risk center, analyst, notifications and builder revenue", async ({
  page,
}, info) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => {
    pageErrors.push(e.message);
  });
  const { secret } = await signUpConnectAnd2fa(page, info);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByText("200,000.00 USDC").first()).toBeVisible();
  await expect(
    page.getByText("Not available: SoDEX has no deposit history.", { exact: false }),
  ).toBeVisible();

  await page.goto("/portfolio");
  await expect(page.getByRole("heading", { name: "Portfolio" })).toBeVisible();
  await expect(
    page.getByText("No open positions.").filter({ visible: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Liquidation price is shown only when SoDEX returns it. DRIFT does not estimate it.",
    ),
  ).toBeVisible();

  await page.goto("/risk");
  await expect(page.getByRole("heading", { name: "Risk Center" })).toBeVisible();
  const daily = page.getByRole("listitem").filter({ hasText: "Daily loss" });
  await daily.getByRole("button", { name: /^(Edit…|Set limit) / }).click();
  await daily.getByLabel("New limit").fill("3");
  await daily.getByRole("button", { name: "Send change to risk engine" }).click();
  await expect(daily.getByText("of 3%")).toBeVisible();
  await expect(page.getByText("Server-enforced").first()).toBeVisible();
  await expect(page.getByText("UI warning only").first()).toBeVisible();
  await page.getByRole("button", { name: "Halt all agents…" }).click();
  const dialog = page.getByRole("dialog", { name: "Halt all agents?" });
  await nextTotpWindow();
  await dialog.getByLabel("2FA code").fill(totp(secret));
  await dialog.getByRole("button", { name: "Halt all agents" }).click();
  await expect(
    page.getByText("Halt requested. Agents show Stopped once DRIFT confirms."),
  ).toBeVisible();

  await page.goto("/analyst");
  await expect(page.getByRole("heading", { name: "AI Analyst" })).toBeVisible();
  await expect(
    page.getByText(/does not predict prices, promise returns, or place orders/),
  ).toBeVisible();
  await expect(page.getByText("Coming soon")).toBeVisible();

  await page.goto("/settings");
  await page.getByRole("tab", { name: "Notifications" }).click();
  await expect(page.getByText("Bot errors, unknown orders, paused bots")).toBeVisible();
  await expect(page.getByRole("switch", { name: "Email" }).first()).toBeDisabled();

  await page.goto("/admin/builder-revenue");
  await expect(page.getByText("Builder Revenue is for the DRIFT team only.")).toBeVisible();
  expect(pageErrors).toEqual([]);
});
