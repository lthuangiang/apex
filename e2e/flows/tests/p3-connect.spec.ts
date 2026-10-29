import { randomBytes } from "node:crypto";

import { expect, test } from "@playwright/test";

import { nextTotpWindow, totp } from "../support/totp";
import { installWallet } from "../support/wallet";

// Tiêu chí P3 (docs/ROADMAP.md): đăng ký → kết nối → thấy key ••last4 và approval 0.01%;
// revoke rồi approve lại được. SoDEX là mock có kiểm tra chữ ký thật.

test("sign up, connect with two signatures, revoke, approve again and disconnect", async ({
  page,
}, info) => {
  const email = `e2e-${info.project.name}-${String(Date.now())}@drift.test`;
  const address = await installWallet(page, `0x${randomBytes(32).toString("hex")}`);
  const accountID = 400_000 + Math.floor(Math.random() * 100_000);
  const registered = await fetch(`${process.env.E2E_MOCK_CONTROL ?? ""}/__mock/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, accountID }),
  });
  expect(registered.status).toBe(204);
  const NOW = Date.now();
  await fetch(`${process.env.E2E_MOCK_CONTROL ?? ""}/__mock/history`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      address,
      positions: [
        {
          id: 1,
          symbol: "BTC-USD",
          marginMode: "CROSS",
          positionSide: "LONG",
          size: "0",
          avgEntryPrice: "60000",
          cumTradingFee: "3",
          cumFundingFee: "0",
          cumClosedSize: "0.1",
          avgClosePrice: "61000",
          maxSize: "0.1",
          realizedPnL: "97",
          leverage: 10,
          active: false,
          createdAt: NOW - 3 * 3_600_000,
          updatedAt: NOW - 3_600_000,
        },
      ],
      perpsTrades: [
        {
          symbol: "BTC-USD",
          tradeID: 1,
          orderID: 1,
          clOrdID: "a",
          side: "BUY",
          price: "60000",
          quantity: "0.1",
          fee: "1.5",
          feeCoin: "vUSDC",
          isMaker: true,
          time: NOW - 3 * 3_600_000,
        },
        {
          symbol: "BTC-USD",
          tradeID: 2,
          orderID: 2,
          clOrdID: "b",
          side: "SELL",
          price: "61000",
          quantity: "0.1",
          fee: "1.5",
          feeCoin: "vUSDC",
          isMaker: false,
          time: NOW - 3_600_000,
        },
      ],
      fundings: [
        {
          symbol: "BTC-USD",
          positionID: 1,
          positionSide: "LONG",
          fundingFee: "4",
          feeCoin: "vUSDC",
          timestamp: NOW - 2 * 3_600_000,
        },
      ],
      accountValue: "1000",
    }),
  });

  // Onboarding 1: email + mật khẩu (DEC-76).
  await page.goto("/signup");
  await expect(page.getByRole("heading", { name: "Create your DRIFT account" })).toBeVisible();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("e2e correct horse battery");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create account" }).click();

  // Onboarding 2: hai chữ ký (DEC-25).
  await expect(page).toHaveURL(/\/onboarding\/connect$/);
  await page.getByRole("button", { name: "Connect your SoDEX master wallet" }).click();
  // Danh sách ví: ví extension phổ biến chưa cài hiện "Not detected"; WalletConnect cần Project ID.
  await expect(page.getByRole("heading", { name: "Choose your wallet" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Binance Wallet\s*Not detected in this browser/ }),
  ).toBeDisabled();
  await expect(page.getByRole("button", { name: /OKX Wallet/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: /WalletConnect\s*Not configured/ })).toBeDisabled();
  await page.getByRole("button", { name: "Browser wallet" }).click();
  await expect(page.getByText(`SoDEX account #${String(accountID)} · Mainnet`)).toBeVisible();
  await expect(page.getByText("UserSignedAddPermissionedAPIKeyAction")).toBeVisible();
  await page.getByRole("button", { name: "Sign 1 of 2: create key" }).click();
  await expect(page.getByText("ApproveBuilderFeeAction")).toBeVisible();
  await page.getByRole("button", { name: "Sign 2 of 2: approve fee" }).click();

  const done = page.getByRole("status", { name: "Connected · confirmed by SoDEX" });
  await expect(done).toBeVisible();
  await expect(done).toContainText(/DRIFT · ••[0-9a-f]{4} · expires/);
  await expect(done).toContainText("DRIFT #1645 · up to 0.01% · found in Spot and Perps approvals");
  // Onboarding 3–4: import (jobs qua outbox → NATS) rồi phân tích.
  await page.getByRole("link", { name: "Import my history" }).click();
  await expect(page.getByRole("heading", { name: "Importing your SoDEX history" })).toBeVisible();
  await page.getByRole("link", { name: "See my analysis" }).click({ timeout: 60_000 });
  await expect(page.getByRole("heading", { name: "Where your trading profit went" })).toBeVisible();
  // gross +100, phí −3, funding −4 → net +93.00
  const pnl = page.getByRole("region", { name: "Where your trading profit went" });
  await expect(pnl.getByText("+93.00")).toBeVisible();
  await expect(pnl.getByText("+100.00")).toBeVisible();
  // Màn kết nối vẫn mở được từ Settings; quay lại Settings để làm tiếp phần revoke.

  // Settings › SoDEX access đọc lại đúng trạng thái.
  await page.goto("/settings");
  await expect(page.getByText(`SoDEX account #${String(accountID)}`)).toBeVisible();
  await expect(page.getByText(/^DRIFT · ••[0-9a-f]{4}$/)).toBeVisible();
  await expect(page.getByText("● Approved")).toBeVisible();
  await expect(page.getByText("✕ Withdraw or transfer")).toBeVisible();

  // Revoke cần 2FA: bật 2FA ở tab Security trước.
  await page.getByRole("tab", { name: "Security" }).click();
  await page.getByRole("button", { name: "Set up 2FA" }).click();
  const secret = (await page.locator("code").innerText()).replace(/\s/g, "");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByLabel("6-digit code from the app").fill(totp(secret));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(
    page.getByText("Save these backup codes. Each works once if you lose your phone."),
  ).toBeVisible();
  await page.getByRole("button", { name: "I saved them · turn on 2FA" }).click();
  await expect(page.getByText("● On")).toBeVisible();

  await page.getByRole("tab", { name: "SoDEX access" }).click();
  await page.getByRole("button", { name: "Revoke (set to 0)…" }).click();
  const dialog = page.getByRole("dialog", { name: "Revoke DRIFT’s builder fee?" });
  await nextTotpWindow();
  await dialog.getByLabel("2FA code").fill(totp(secret));
  await dialog.getByRole("button", { name: "Sign to revoke" }).click();
  await expect(page.getByText("❚❚ Revoked")).toBeVisible();
  await expect(page.getByText("All LIVE bots are paused.")).toBeVisible();

  await page.getByRole("button", { name: "Sign to approve 0.01% again" }).click();
  await expect(page.getByText("● Approved")).toBeVisible();

  // Disconnect: 2FA + hai chữ ký master wallet (Spot, Perps) (DEC-31).
  await page.getByRole("button", { name: "Disconnect…" }).click();
  const disconnect = page.getByRole("dialog", {
    name: `Disconnect SoDEX account #${String(accountID)}?`,
  });
  await nextTotpWindow();
  await disconnect.getByLabel("2FA code").fill(totp(secret));
  await disconnect.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByText("No SoDEX account connected.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Connect SoDEX" })).toBeVisible();
});
