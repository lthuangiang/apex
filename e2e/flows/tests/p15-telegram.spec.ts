import { expect, test } from "@playwright/test";

import { sql, sqlUntil } from "../support/db";
import { signUpConnectAnd2fa } from "../support/onboard";
import { telegramMessages, telegramUpdate, type SentMessage } from "../support/telegram-mock";

// Telegram (docs/NOTIFICATIONS.md mục 10, N5): kết nối từ Settings → /start qua webhook → tin thử → thông báo thật qua
// worker của jobs → /stop. Bot API là mock HTTP, không bao giờ gọi api.telegram.org; tin không bao giờ chứa ví hay token.

async function waitMessages(chatId: number, n: number, timeoutMs = 30_000): Promise<SentMessage[]> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const got = await telegramMessages(chatId);
    if (got.length >= n) return got;
    if (Date.now() > until)
      throw new Error(`expected ${String(n)} Telegram messages, got ${String(got.length)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

test("connect Telegram, get a test and a real alert, then /stop", async ({ page }, info) => {
  const { email, address } = await signUpConnectAnd2fa(page, info, { emailPrefix: "e2e-tg" });
  const chatId = 900_000_000 + Math.floor(Math.random() * 1e6);

  await test.step("Connect Telegram opens a one-time link", async () => {
    await page.goto("/settings?tab=notifications");
    await page.getByRole("button", { name: "Connect Telegram" }).click();
    const dialog = page.getByRole("dialog", { name: "Connect Telegram" });
    await expect(dialog).toBeVisible();
    const href = await dialog.getByRole("link", { name: "Open Telegram" }).getAttribute("href");
    const token = new URL(href ?? "").searchParams.get("start") ?? "";
    expect(href).toMatch(/^https:\/\/t\.me\/desklabsbot\?start=/);

    // Telegram gửi /start <token> tới webhook; api trả lời ngay trong body.
    const started = await telegramUpdate(chatId, `/start ${token}`);
    expect(started.status).toBe(200);
    expect(started.body.method).toBe("sendMessage");
    expect(started.body.text).toContain("Connected to DeskLabs ✓");
    // Kết nối xong, dialog đổi sang bước 2 (tiêu đề mới).
    const connected = page.getByRole("dialog", { name: "Telegram connected" });
    await expect(connected).toBeVisible({ timeout: 20_000 });
    await expect(connected.getByText("Alerts go to @e2e_tester")).toBeVisible();
    // Token chỉ dùng được một lần.
    const again = await telegramUpdate(chatId + 1, `/start ${token}`);
    expect(again.body.text).toContain("This link expired.");
    await connected.getByRole("button", { name: "Done" }).click();
  });

  await test.step("Send a test reaches the chat", async () => {
    await page
      .getByRole("button", { name: /^Send a test/ })
      .first()
      .click();
    await expect(page.getByText("Sent. Check Telegram.")).toBeVisible({ timeout: 20_000 });
    const [m] = await waitMessages(chatId, 1);
    expect(m?.text).toContain("Test message from DeskLabs");
  });

  await test.step("a risk alert goes through the jobs worker", async () => {
    const userId = sql(`select id from users where email = '${email.replace(/'/g, "''")}'`);
    sql(`insert into outbox (id, topic, payload) values (gen_random_uuid(), 'jobs.notify',
      '{"userId":"${userId}","type":"risk_alert","data":{"kind":"daily_loss"}}')`);
    await sqlUntil(
      `select id from notifications where user_id = '${userId}' and channel = 'telegram' and delivery_status = 'sent'`,
    );
    const all = await waitMessages(chatId, 2);
    const alert = all.find((m) => m.text.includes("Risk limit reached"));
    expect(alert?.text).toContain("Your daily loss limit was hit.");
    const button = alert?.reply_markup?.inline_keyboard?.[0]?.[0];
    expect(button?.text).toBe("Open Risk Center");
    expect(button?.url).toMatch(/\/risk$/);
    // Quét output: không có địa chỉ ví hay email đầy đủ.
    for (const m of all) {
      expect(m.text.toLowerCase()).not.toContain(address.toLowerCase());
      expect(m.text).not.toContain(email);
    }
  });

  await test.step("/stop disconnects, and Settings shows it", async () => {
    const stopped = await telegramUpdate(chatId, "/stop");
    expect(stopped.body.text).toBe("Disconnected from DeskLabs.");
    await page.reload();
    await expect(page.getByRole("button", { name: "Connect Telegram" })).toBeVisible({
      timeout: 20_000,
    });
  });
});
