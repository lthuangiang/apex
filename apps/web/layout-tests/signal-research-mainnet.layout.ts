import { readFileSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

import {
  ARTICLES,
  LATENCY_1D,
  SUMMARY_1D,
  TRACES,
} from "../src/features/signal-analysis/__tests__/news-trace-fixtures";
import { RESEARCH_TRADES } from "../src/features/signal-analysis/__tests__/research-fixtures";
import {
  CLASSIFIERS,
  MARKETS,
  VERSIONS,
} from "../src/features/signal-analysis/__tests__/versions-fixtures";

// #421: chế độ Mainnet của trang Signal Research (/signal-research?bots=mainnet) không bao giờ cuộn ngang, ở 1024 / 1280 /
// 1440 (project) và 390: dải Mainnet, ô Bots / Bot, dòng bot có Pause / Stop…, Signals in the last 24 h, Mainnet trades,
// và editor "Start bot from a version". API giả trả như API #443. Câu chữ chờ duyệt đọc từ en.json.

interface MainnetCopy {
  trades: { title: string };
  signals: { title: string };
  strip: { pause: string };
  count: { start: string };
}
const M = (
  JSON.parse(readFileSync(new URL("../messages/en.json", import.meta.url), "utf8")) as {
    signalAnalysis: { research: { mainnet: MainnetCopy } };
  }
).signalAnalysis.research.mainnet;
const BOT_ID = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-11-22T10:00:00.000Z";
const BOT = {
  id: BOT_ID,
  name: "News · Baseline (v3) · a longer bot name",
  strategy: "news_signal",
  market: "",
  engine: "perps",
  state: "running",
  reasonCode: null,
  needsAttention: false,
  activeVersion: 1,
  netPnl: null,
  createdAt: NOW,
  updatedAt: NOW,
};
const TRADES = [
  {
    id: "22222222-2222-4222-8222-222222222222",
    signalId: "33333333-3333-4333-8333-333333333333",
    market: "SOL-USD",
    side: "short",
    status: "open",
    sizeUsdc: "100",
    qty: "0.47",
    entryAvgPrice: "212.4",
    tpPrice: "205.1",
    slPrice: "216.05",
    maxHoldUntil: "2026-11-22T23:42:00.000Z",
    openedAt: "2026-11-22T21:42:00.000Z",
    closedAt: null,
    closeReason: null,
    exitAvgPrice: null,
    pendingCommand: null,
  },
  {
    id: "22222222-2222-4222-8222-222222222223",
    signalId: "33333333-3333-4333-8333-333333333334",
    market: "HYPE-USD",
    side: "short",
    status: "closed",
    sizeUsdc: "100",
    qty: "2.42",
    entryAvgPrice: "41.22",
    tpPrice: "39.93",
    slPrice: "41.86",
    maxHoldUntil: "2026-11-22T22:05:00.000Z",
    openedAt: "2026-11-22T20:05:00.000Z",
    closedAt: "2026-11-22T20:58:00.000Z",
    closeReason: "TAKE_PROFIT",
    exitAvgPrice: "39.93",
    pendingCommand: null,
  },
];
const SIGNALS = [
  {
    id: "33333333-3333-4333-8333-333333333333",
    market: "SOL-USD",
    catalyst: "hack_exploit",
    side: "short",
    level: "high",
    decidedAt: NOW,
    expiresAt: NOW,
    outcome: "accepted",
    reason: null,
  },
  {
    id: "33333333-3333-4333-8333-333333333335",
    market: "BTC-USD",
    catalyst: "listing",
    side: "long",
    level: "low",
    decidedAt: NOW,
    expiresAt: NOW,
    outcome: "dropped",
    reason: "LEVEL_TOO_LOW",
  },
];

async function open(
  page: Page,
  baseURL: string | undefined,
  mode: "paper" | "mainnet" = "mainnet",
) {
  await page
    .context()
    .addCookies([{ name: "drift_session", value: "x", url: baseURL ?? "http://127.0.0.1" }]);
  await page.route("**/api/**", async (r) => {
    const p = new URL(r.request().url()).pathname;
    const json = (body: unknown, status = 200) =>
      r.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (p === "/api/v1/features")
      return json({
        volumeMaker: false,
        volumeFarm: false,
        aiDesk: true,
        adaptiveDca: false,
        signalResearch: true,
      });
    if (p === "/api/v1/me")
      return json({
        id: "00000000-0000-4000-8000-0000000000aa",
        email: "tester@drift.test",
        displayName: null,
        timezone: "UTC",
        numberFormat: "en-US",
        twoFactorEnabled: false,
        role: "user",
      });
    if (p === "/api/v1/signal-research/bots") return json({ items: [BOT] });
    if (p.endsWith(`/bots/${BOT_ID}/trades`)) return json({ items: TRADES });
    if (p.endsWith(`/bots/${BOT_ID}/signals`)) return json({ items: SIGNALS });
    if (p.endsWith("/signal-research/trades")) return json(RESEARCH_TRADES);
    if (p.endsWith("/signal-research/summary")) return json(SUMMARY_1D);
    if (p.endsWith("/signal-research/articles/new")) return json({ items: [], since: "c1" });
    if (p.endsWith("/signal-research/latency")) return json(LATENCY_1D);
    if (p.endsWith("/signal-research/versions")) return json(VERSIONS);
    if (p.endsWith("/signal-research/classifiers")) return json(CLASSIFIERS);
    if (p.endsWith("/signal-research/markets")) return json(MARKETS);
    if (p.endsWith("/signal-research/articles"))
      return json({ items: ARTICLES, nextCursor: null, total: ARTICLES.length, totalInRange: 58 });
    const m = /\/signal-research\/articles\/([^/]+)\/trace$/.exec(p);
    const tr = m === null ? undefined : TRACES[decodeURIComponent(m[1] ?? "")];
    if (tr !== undefined) return json(tr);
    return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
  });
  if (mode === "paper") {
    await page.goto("/signal-research");
    await page.getByRole("button", { name: "How it works", exact: true }).waitFor();
    return;
  }
  await page.goto("/signal-research?bots=mainnet");
  await page.getByRole("heading", { name: M.trades.title }).waitFor();
}

async function sideScroll(page: Page) {
  await page.evaluate(
    () => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))),
  );
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

for (const narrow of [false, true]) {
  const tag = narrow ? " at 390" : "";

  test(`Signal Research Mainnet${tag}: no side scroll; editor opens without side scroll`, async ({
    page,
    baseURL,
  }) => {
    if (narrow) await page.setViewportSize({ width: 390, height: 844 });
    await open(page, baseURL);
    await expect(page.getByRole("heading", { name: M.signals.title })).toBeVisible();
    await expect(page.getByRole("button", { name: M.strip.pause })).toBeVisible();
    expect.soft(await sideScroll(page), "page does not scroll sideways").toBeLessThanOrEqual(0);
    await page.getByRole("button", { name: M.count.start }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect
      .soft(await sideScroll(page), "editor open: page does not scroll sideways")
      .toBeLessThanOrEqual(0);
  });
}

// #454: drawer How it works › Overview bản Mainnet: không cuộn ngang (sơ đồ cuộn trong khung của nó), khối không bị ép dẹt.
for (const narrow of [false, true]) {
  test(`Mainnet How it works${narrow ? " at 390" : ""}: no side scroll, nothing squashed`, async ({
    page,
    baseURL,
  }) => {
    if (narrow) await page.setViewportSize({ width: 390, height: 844 });
    await open(page, baseURL);
    await page.getByRole("button", { name: "How it works", exact: true }).click();
    const dlg = page.getByRole("dialog", { name: "How it works" });
    await expect(dlg.getByTestId("hiw-mainnet-list")).toBeVisible();
    const m = await dlg.evaluate((el) => {
      const panel = el.querySelector<HTMLElement>("[role='tabpanel']");
      const kids = panel === null ? [] : [...panel.children].map((c) => c as HTMLElement);
      return {
        overflowX: el.scrollWidth - el.clientWidth,
        squashed: kids.filter((k) => k.getBoundingClientRect().height + 1 < k.scrollHeight).length,
      };
    });
    expect.soft(m.overflowX, "drawer does not scroll sideways").toBeLessThanOrEqual(0);
    expect.soft(m.squashed, "no block is squashed").toBe(0);
    expect.soft(await sideScroll(page), "page does not scroll sideways").toBeLessThanOrEqual(0);
  });
}

// #454: ảnh đầu trang (Paper / Mainnet) và drawer How it works › Overview cho PR, chỉ chạy khi có MODE_SHOTS (thư mục ra).
const shots = process.env.MODE_SHOTS;
for (const width of [1440, 390]) {
  test(`mode colors screenshots at ${String(width)}`, async ({ page, baseURL }, info) => {
    test.skip(shots === undefined || info.project.name !== "w1440", "screenshots only on demand");
    if (width === 390) await page.setViewportSize({ width: 390, height: 844 });
    for (const mode of ["paper", "mainnet"] as const) {
      await open(page, baseURL, mode);
      await page.screenshot({ path: `${shots ?? "."}/${mode}-top-${String(width)}.png` });
      await page.getByRole("button", { name: "How it works", exact: true }).click();
      const dlg = page.getByRole("dialog", { name: "How it works" });
      await dlg.getByRole("tab", { name: "Overview" }).waitFor();
      await page.screenshot({ path: `${shots ?? "."}/${mode}-drawer-${String(width)}.png` });
    }
  });
}
