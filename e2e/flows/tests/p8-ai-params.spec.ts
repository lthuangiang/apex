import { expect, test } from "@playwright/test";

import { signUpConnectAnd2fa } from "../support/onboard";

// Tiêu chí P8 (docs/ROADMAP.md): onboarding 5–6 → kế hoạch từ engine đề xuất → màn tạo bot với
// AI parameters → Clear → nhập tay. Thống kê thị trường do global-setup nạp; nến ngày từ mock SoDEX.

test("goals, strategy plan, AI parameters, clear and fill manually", async ({ page }, info) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => {
    pageErrors.push(e.message);
  });
  await signUpConnectAnd2fa(page, info);

  await page.goto("/onboarding/goals");
  await expect(page.getByRole("heading", { name: "What do you want DRIFT to do?" })).toBeVisible();
  await page.getByRole("radio", { name: /Earn from sideways markets/ }).click();
  await page.getByLabel("2. Capital for bots").fill("2000");
  await page.getByRole("radio", { name: /^10%/ }).click();
  await page.getByRole("button", { name: /BTC/ }).click();
  await page.getByRole("button", { name: "Show my strategy plan" }).click();

  await expect(
    page.getByRole("heading", { name: "Strategies that fit how you trade" }),
  ).toBeVisible();
  const best = page.getByRole("article", { name: "Spot Grid · vBTC_vUSDC" });
  await expect(best.getByText("BEST FIT")).toBeVisible({ timeout: 15_000 });
  await expect(best.getByText(/covers 90% of BTC daily closes/)).toBeVisible();
  await expect(page.getByText("Paper trading")).toBeVisible();
  await page.getByRole("link", { name: /Review \d bots? for mainnet/ }).click();

  await expect(page.getByRole("heading", { name: "Create Spot Grid" })).toBeVisible();
  await expect(page.getByText(/✦ Filled by AI/)).toBeVisible({ timeout: 15_000 });
  const lower = page.getByLabel("Lower price");
  await expect(lower).toHaveValue("92");
  await expect(page.getByText("AI", { exact: true }).first()).toBeVisible();
  await page.getByLabel("Grid levels").fill("4");
  await expect(page.getByText("Edited", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Clear parameters" }).click();
  await expect(lower).toHaveValue("");
  await expect(lower).toHaveAttribute("placeholder", "e.g. 92");
  await expect(page.getByRole("button", { name: "✦ AI parameters" })).toBeVisible();

  await lower.fill("90");
  await page.getByLabel("Upper price").fill("110");
  await page.getByLabel("Grid levels").fill("5");
  await page.getByLabel("Investment").fill("500");
  await page.getByLabel("Max loss for this bot").fill("100");
  await page.getByRole("button", { name: "Save draft" }).click();
  const checks = page.getByRole("region", { name: "Before it starts" });
  await expect(checks.getByText("Builder fee approval")).toBeVisible();
  expect(pageErrors).toEqual([]);
});
