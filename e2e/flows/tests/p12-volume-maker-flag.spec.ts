import { expect, test } from "@playwright/test";

import { signUpConnectAnd2fa } from "../support/onboard";

// P12 (VOLUME_MAKER.md mục 17.5): chưa có xác nhận bằng văn bản của SoDEX nên VOLUME_MAKER_ENABLED=false —
// Volume Maker không có trong catalog và route tạo bot trả 404.

test("Volume Maker stays hidden while VOLUME_MAKER_ENABLED is off", async ({ page }, info) => {
  await signUpConnectAnd2fa(page, info);
  await page.goto("/bots");
  await page.getByRole("tab", { name: "Strategy catalog 8" }).click();
  await expect(page.getByRole("link", { name: "Set up Spot Grid" })).toBeVisible();
  await expect(page.getByText("Volume Maker")).toHaveCount(0);
  const res = await page.goto("/bots/new/volume_maker");
  expect(res?.status()).toBe(404);
});
