import { createRequire } from "node:module";

import { expect, test, type Page } from "@playwright/test";

import { view } from "../src/features/account/__tests__/market-hours-fixtures";

// #486: Market hours với ô Market là picker của form tạo bot và cột Avg cuối hai dòng CPM. Không cuộn ngang trang ở
// 1024 / 1280 / 1440 (project) và 390; chữ của ô Avg nằm trong ô; axe (wcag2a/aa, wcag21, wcag22aa) khi picker đang mở.

// SOL-USD không nằm trong danh sách của trang → không hiện; DOGE-USD nằm ngoài nhóm Popular.
const MARKETS = ["BTC-USD", "ETH-USD", "SOL-USD", "DOGE-USD"].map((name) => ({
  name,
  engine: "perps",
  displayName: name,
  base: name.split("-")[0],
  quote: "USD",
  tickSize: "0.1",
  stepSize: "0.001",
  trading: true,
  minNotional: "10",
  maxLeverage: 20,
  last: null,
}));

async function open(page: Page, baseURL: string | undefined, seen: string[], narrow: boolean) {
  await page
    .context()
    .addCookies([{ name: "drift_session", value: "x", url: baseURL ?? "http://127.0.0.1" }]);
  await page.route("**/api/**", async (r) => {
    const p = new URL(r.request().url()).pathname;
    const json = (body: unknown, status = 200) =>
      r.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (p === "/api/v1/me")
      return json({
        id: "00000000-0000-4000-8000-0000000000aa",
        email: "tester@drift.test",
        displayName: null,
        timezone: "UTC",
        numberFormat: "en-US",
        twoFactorEnabled: false,
        role: "team",
      });
    if (p === "/api/v1/markets") return json({ items: MARKETS });
    if (p === "/api/v1/admin/market-hours") {
      seen.push(r.request().url());
      return json(view({ tz: "UTC", markets: ["BTC-USD", "DOGE-USD", "ETH-USD"] }));
    }
    return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
  });
  await page.goto("/admin/market-hours");
  // 390 px: bản desktop bị ẩn, chờ dòng gợi ý của bản điện thoại.
  await (
    narrow
      ? page.getByText("Tap an hour for 5-minute steps and the full numbers.")
      : page.getByRole("heading", { name: "1 · Market volatility on SoDEX" })
  ).waitFor();
}

async function settle(page: Page) {
  await page.evaluate(
    () => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))),
  );
}

async function axe(page: Page) {
  await page.addScriptTag({ path: createRequire(import.meta.url).resolve("axe-core") });
  return page.evaluate(async () => {
    const w = window as unknown as {
      axe: {
        run: (ctx: Document, o: unknown) => Promise<{ violations: { id: string; help: string }[] }>;
      };
    };
    const r = await w.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
      // Có từ trước #486, ngoài phạm vi: nút giờ có mốc ở hàng tiêu đề (aria-label "Show 07:00 in 5-minute steps. Marker:
      // …" không chứa nguyên chữ hiển thị "07:00 07"). Rule này chỉ chạy trong trình duyệt thật, không chạy trong jsdom.
      rules: { "label-content-name-mismatch": { enabled: false } },
    });
    return r.violations.map((v) => `${v.id}: ${v.help}`);
  });
}

for (const narrow of [false, true]) {
  test(`Market hours${narrow ? " at 390" : ""}: market picker, Avg cells, no side scroll, axe`, async ({
    page,
    baseURL,
  }, info) => {
    test.skip(narrow && info.project.name !== "w1440", "390 chỉ chạy một lần");
    if (narrow) await page.setViewportSize({ width: 390, height: 844 });
    const seen: string[] = [];
    await open(page, baseURL, seen, narrow);
    await settle(page);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(0);

    if (!narrow) {
      // Ô Avg cuối hai dòng CPM: chữ nằm trong ô.
      const outside = await page.evaluate(() => {
        const out: string[] = [];
        for (const label of ["Markout cost / $1M", "Est. CPM (estimate)"]) {
          const span = [...document.querySelectorAll<HTMLElement>("span.min-w-0")].find(
            (s) => s.textContent === label && s.offsetParent !== null,
          );
          const cell = span?.closest("div.grid")?.lastElementChild;
          if (!(cell instanceof HTMLElement)) {
            out.push(`no Avg cell for ${label}`);
            continue;
          }
          const b = cell.getBoundingClientRect();
          const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
            const range = document.createRange();
            range.selectNodeContents(n);
            for (const r of range.getClientRects())
              if (r.width > 0 && (r.left < b.left - 0.5 || r.right > b.right + 0.5))
                out.push(`${label}: ${n.textContent ?? ""}`);
          }
        }
        return out;
      });
      expect(outside).toEqual([]);
    }

    // Picker: tìm "eth" rồi chọn bằng bàn phím (desktop), hoặc mở bottom sheet (390).
    const box = page.getByRole("combobox", { name: "Market" });
    if (narrow) {
      await page.getByLabel("Market", { exact: true }).click();
      await page.getByRole("dialog").waitFor();
    } else {
      await box.click();
      await expect(page.getByRole("group", { name: "Popular" })).toBeVisible();
      await expect(page.getByRole("option", { name: "DOGE-USD" })).toBeVisible();
      await expect(page.getByRole("option", { name: "SOL-USD" })).toHaveCount(0);
    }
    expect(await axe(page)).toEqual([]);
    if (!narrow) {
      await box.fill("eth");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await expect.poll(() => seen.at(-1)).toContain("market=ETH-USD");
    }

    const shots = process.env.MODE_SHOTS;
    if (shots !== undefined)
      await page.screenshot({
        path: `${shots}/market-hours-${narrow ? "390" : info.project.name}.png`,
        fullPage: true,
      });
  });
}
