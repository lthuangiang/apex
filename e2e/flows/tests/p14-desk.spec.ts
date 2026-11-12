import { expect, test } from "@playwright/test";

import { claudeMode, claudeRequests } from "../support/claude-mock";
import { sql, sqlUntil } from "../support/db";
import { signUpConnectAnd2fa } from "../support/onboard";

// AI Desk B+ (DEC-166, M7): Needs you → so sánh → Apply → version "AI suggested"; Desk AI trả lời qua Claude API giả;
// LLM lỗi hay hết 20 câu thì app vẫn chạy bằng câu mẫu; ✦ hỏi đúng ngữ cảnh bot. SoDEX là mock, Claude là mock, không
// gửi lệnh nào: bot seed ở trạng thái paused.

const FARM = {
  market: "BTC-USD",
  leverage: 5,
  marginMode: "cross",
  orderSizeMinUsd: "100",
  orderSizeMaxUsd: "200",
  minHoldSecs: 120,
  maxHoldSecs: 180,
  tpUsd: "0.5",
  slPct: "5",
  earlyProfitUsd: "0.15",
  maxLoss: "20",
};
const BEST = {
  earlyProfitFees: 3,
  earlyExitSecs: 60,
  minHoldSecs: 180,
  maxHoldSecs: 300,
  slMarginPct: 50,
};
const REVIEW = {
  status: "done",
  trades: 120,
  from: 0,
  to: 1,
  volume: 50000,
  actual: {
    costPerMillion: 320,
    feesPerMillion: 300,
    builderPerMillion: 10,
    pricePerMillion: 20,
    winRatePct: 40,
  },
  current: { params: { ...BEST, slMarginPct: 25 }, costPerMillion: 320, winRatePct: 40 },
  best: {
    params: BEST,
    costPerMillion: 250,
    winRatePct: 45,
    deltaPerMillion: -70,
    ciLow: -90,
    ciHigh: -10,
    inSample: 255,
    outOfSample: 248,
    currentInSample: 318,
    currentOutOfSample: 322,
  },
  recommended: true,
  suggestion: "strong",
  tested: 135,
  takerShare: { trades: 10, takerCostPerMillion: 400, makerCostPerMillion: 300 },
};
const q = (s: string) => s.replace(/'/g, "''");

test("Needs you → compare → Apply, Desk AI answers and falls back, ✦ asks about the right bot", async ({
  page,
}, info) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => {
    pageErrors.push(e.message);
  });
  // Báo cáo sáng (tạo khi mở /desk) dùng lời riêng để không lẫn với câu trả lời của câu hỏi.
  await claudeMode("ok", "Good morning from Desk AI.");
  const { email } = await signUpConnectAnd2fa(page, info, { emailPrefix: "e2e-desk" });

  // Bot Volume Builder thật (paused, không gửi lệnh) có Review this run "strong" chưa áp dụng → việc "Needs you" quy tắc 4.
  const userId = sql(`select id from users where email = '${q(email)}'`);
  const accountId = sql(
    `select id from sodex_accounts where user_id = '${userId}' order by created_at desc limit 1`,
  );
  const botId =
    sql(`insert into bots (id, user_id, sodex_account_id, strategy, market, engine, name, state, mode)
    values (gen_random_uuid(), '${userId}', '${accountId}', 'volume_farm', 'BTC-USD', 'perps', 'Desk Farm', 'paused', 'live')
    returning id`);
  const versionId =
    sql(`insert into bot_versions (id, bot_id, version, config, param_source, status, applied_at)
    values (gen_random_uuid(), '${botId}', 1, '${q(JSON.stringify(FARM))}', 'manual', 'active', now() - interval '1 hour')
    returning id`);
  sql(`update bots set active_version_id = '${versionId}' where id = '${botId}'`);
  sql(`insert into bot_reviews (id, bot_id, user_id, status, result, finished_at)
       select gen_random_uuid(), id, user_id, 'done', '${q(JSON.stringify(REVIEW))}', now() from bots where id = '${botId}';`);

  await test.step("Needs you → compare → Apply creates an AI suggested version", async () => {
    await page.goto("/desk");
    await expect(page.getByText("Review this run found better settings")).toBeVisible({
      timeout: 20_000,
    });
    // Thẻ tự bấm Compare; worker backtest chạy so sánh (không có lượt thật → "Not enough trades").
    const whatifId = await sqlUntil(
      `select id from desk_whatifs where bot_id = '${botId}' and status = 'done' limit 1`,
      60_000,
    );
    // Kết quả 7 ngày như worker sẽ ghi khi có lượt thật.
    const options = JSON.parse(
      sql(`select options from desk_whatifs where id = '${whatifId}'`),
    ) as { key: string }[];
    const done = options.map((o) => ({
      ...o,
      unavailable: null,
      outcome: {
        trades: 120,
        net: o.key === "keep" ? "-4.95" : "-3.10",
        closedBySodex: 0,
        worstTrade: "-1.20",
        marginPerTrade: "40",
      },
    }));
    sql(`update desk_whatifs set options = '${q(JSON.stringify(done))}' where id = '${whatifId}'`);

    await page.goto(`/desk/compare/${whatifId}`);
    await expect(page.getByRole("heading", { name: "Pick a fix" })).toBeVisible();
    await expect(page.getByText("My pick")).toBeVisible();
    await expect(page.getByText("Use the Review this run settings").first()).toBeVisible();
    await page.getByRole("button", { name: "Apply this fix" }).click();
    await expect(page.getByText(/Applied as v2|Applying v2/)).toBeVisible({ timeout: 20_000 });
    expect(
      sql(`select param_source from bot_versions where bot_id = '${botId}' and version = 2`),
    ).toBe("ai");
  });

  await test.step("Desk AI answers through the model, then falls back when it fails", async () => {
    await claudeMode("ok", "Your bot is paused, so it is not trading right now.");
    await page.goto("/desk");
    const box = page.getByLabel("Ask Desk AI");
    const send = page.getByRole("button", { name: "Send" });
    await box.fill("Why is my bot not trading?");
    await send.click();
    await expect(page.getByText("Your bot is paused, so it is not trading right now.")).toBeVisible(
      { timeout: 20_000 },
    );
    // Câu trả lời đã về thì ô nhập trống; lúc đó mới hỏi tiếp.
    await expect(box).toHaveValue("");

    await claudeMode("error");
    await box.fill("Why did I lose money?");
    await send.click();
    await expect(
      page.getByText("I can’t write an answer right now. Here are the numbers I have:"),
    ).toBeVisible({ timeout: 60_000 });
    await expect(box).toHaveValue("");
    await expect(page.getByRole("heading", { name: /Needs you/ })).toBeVisible();
  });

  await test.step("after 20 questions Desk AI answers with the template", async () => {
    sql(`update desk_ai_usage set questions = 20
         where user_id = (select id from users where email = '${q(email)}')`);
    await claudeMode("ok", "This should not be shown.");
    const before = (await claudeRequests()).length;
    await page.getByLabel("Ask Desk AI").fill("One more question?");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.getByText("You've asked 20 questions today. I'll answer more tomorrow."),
    ).toBeVisible({ timeout: 20_000 });
    expect((await claudeRequests()).length).toBe(before);
  });

  await test.step("✦ asks about the bot it sits next to", async () => {
    sql(`update desk_ai_usage set questions = 0
         where user_id = (select id from users where email = '${q(email)}')`);
    await claudeMode("ok", "This bot is paused right now.");
    await page.goto(`/agent/${botId}`);
    await page.getByRole("button", { name: "Ask Desk AI about this" }).first().click();
    await expect(page.getByRole("dialog", { name: "About this bot" })).toBeVisible();
    const before = (await claudeRequests()).length;
    // Mở sheet không tốn lượt, không gọi model.
    expect((await claudeRequests()).length).toBe(before);
    await page.getByRole("button", { name: "How is this bot doing?" }).click();
    await expect(page.getByText("This bot is paused right now.")).toBeVisible({ timeout: 20_000 });
    const last = (await claudeRequests()).at(-1);
    expect(JSON.stringify(last)).toContain("Desk Farm");
  });

  expect(pageErrors).toEqual([]);
});
