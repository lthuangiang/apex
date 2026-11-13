import { expect, test } from "@playwright/test";

import { signUpConnectAnd2fa } from "../support/onboard";
import { nextTotpWindow, totp } from "../support/totp";

// Copy Trading v1 (DEC-163): Find traders → Trader profile → Budget and safety → Review and start → bot chạy.
// Trader Hyperliquid và thống kê do global-setup seed (thay scheduler); SoDEX là mock. Hyperliquid không được gọi.

const TRADER = "0xaaa0000000000000000000000000000000000001";

test("find a trader, follow them, and start copying in three steps", async ({ page }, info) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => {
    pageErrors.push(e.message);
  });
  const { secret } = await signUpConnectAnd2fa(page, info, { emailPrefix: "e2e-copy" });

  await page.goto("/traders");
  await expect(page.getByRole("heading", { name: "Find traders to copy" })).toBeVisible();
  await expect(page.getByText("New to copy trading? It takes 3 steps.")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Steady" })).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByText("Past results, not a forecast. Copying can lose money."),
  ).toBeVisible();

  await page.getByRole("link", { name: "View profile" }).first().click();
  await expect(page).toHaveURL(new RegExp(`/traders/${TRADER}$`));
  await expect(page.getByText("Is this trader a good fit to copy?")).toBeVisible();
  await page.getByRole("button", { name: "☆ Follow" }).click();
  await expect(page.getByRole("button", { name: "★ Following" })).toBeVisible();

  await page.goto("/following");
  await expect(page.getByText("1 of 5")).toBeVisible();

  await page.goto(`/traders/${TRADER}`);
  await page.getByRole("link", { name: "Copy future trades" }).first().click();
  await expect(page).toHaveURL(new RegExp(`/bots/new/copy_trade\\?leader=${TRADER}$`));
  await expect(page.getByText("How much do you want to use?")).toBeVisible();
  await page.getByRole("button", { name: "$500" }).click();
  await page.getByRole("radio", { name: /Balanced/ }).click();
  await expect(
    page.getByText("All positions together stay under $1,000 (budget × leverage)."),
  ).toBeVisible();
  // Chọn market và đòn bẩy theo market (DEC-226): mặc định tick mọi market; bỏ hết thì khoá.
  await expect(page.getByRole("heading", { name: "Markets we'll copy · 1 of 1" })).toBeVisible();
  const btc = page.getByRole("checkbox", { name: "Copy BTC-USD" });
  await expect(btc).toBeChecked();
  await btc.uncheck();
  await expect(page.getByText("Pick at least one market.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue to review" })).toBeDisabled();
  await btc.check();
  await expect(page.getByText("Pick at least one market.")).toHaveCount(0);
  const side = page.getByRole("region", { name: "What you'll copy" });
  await expect(side.getByText("1 of 1")).toBeVisible();
  await expect(side.getByText("2×")).toBeVisible();
  await page.getByRole("button", { name: "Continue to review" }).click();

  await expect(page.getByRole("heading", { name: "Review and start" })).toBeVisible();
  await expect(page.getByText("BTC-USD · 2×")).toBeVisible();
  await expect(page.getByText("Mainnet · real funds")).toBeVisible();
  await expect(page.getByText("Withdraw or transfer: never.", { exact: false })).toBeVisible();
  await page.getByRole("checkbox").check();
  await nextTotpWindow();
  await page.getByLabel("2FA code").fill(totp(secret));
  await page.getByRole("button", { name: "Start copying" }).click();
  await expect(page).toHaveURL(/\/agent\/[0-9a-f-]{36}$/, { timeout: 20_000 });
  expect(pageErrors).toEqual([]);
});
