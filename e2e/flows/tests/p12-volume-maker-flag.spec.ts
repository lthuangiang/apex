import { expect, test } from "@playwright/test";

import { sql } from "../support/db";
import { signUpConnectAnd2fa } from "../support/onboard";

// Bot khối lượng theo từng tài khoản (DEC-80 thay `VOLUME_MAKER_ENABLED`; DEC-94 mở mặc định): team tắt "Volume bots"
// cho một tài khoản thì Volume Maker và Volume Builder biến khỏi catalog, route tạo bot hiện trang "không tồn tại".

test("Volume Maker stays hidden for an account the team turned volume bots off for", async ({
  page,
}, info) => {
  const { email } = await signUpConnectAnd2fa(page, info);
  sql(`update users set volume_bots = false where email = '${email.replace(/'/g, "''")}'`);
  await page.goto("/bots");
  await page.getByRole("tab", { name: /^Strategy catalog/ }).click();
  await expect(page.getByRole("link", { name: "Set up Spot Grid" })).toBeVisible();
  await expect(page.getByText("Volume Maker")).toHaveCount(0);
  // Cờ theo tài khoản kiểm tra ở client (DEC-80): route trả trang "không tồn tại", không có form tạo bot.
  await page.goto("/bots/new/volume_maker");
  await expect(
    page.getByRole("heading", { level: 1, name: "This page doesn’t exist." }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Save draft" })).toHaveCount(0);
});
