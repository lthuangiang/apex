import { sourceStatus } from "@drift/db";
import {
  claudeCallsForCycle,
  NEWS_LIMIT_DEFAULTS,
  parseSrLane,
  SOURCE_HEALTH,
  sourceHealthOf,
  SR_LANE_TTL_MS,
} from "@drift/shared";
import { describe, expect, it } from "vitest";

import {
  monthlyLimitWarning,
  parseSignalEnv,
  pipelineConfig,
  scheduleNewsCycle,
  signalResearchEnvSchema,
} from "../src/signal-research/index";
import { collectFloor } from "../src/signal-research/pipeline";
import {
  isSosoRateLimited,
  sosoClient,
  SosoError,
  SosoRateLimiter,
} from "../src/signal-research/soso";

// #394: chu kỳ lane tin tức chỉnh bằng `SIGNAL_NEWS_CYCLE_MINUTES` (1–5, mặc định 5), trần 20 request / phút của
// SoSoValue, và những chỗ từng giả định vòng 5 phút.

const MIN = 60_000;
const envOf = (raw: Record<string, string>) =>
  signalResearchEnvSchema.parse({ SIGNAL_RESEARCH_ENABLED: "true", ...raw });

describe("SIGNAL_NEWS_CYCLE_MINUTES", () => {
  it.each([
    ["1", 1],
    ["5", 5],
    ["3", 3],
  ])("%s is used as is", (v, want) => {
    const p = parseSignalEnv({
      SIGNAL_RESEARCH_ENABLED: "true",
      SOSO_API_KEY: "k",
      DESK_AI_API_KEY: "c",
      SIGNAL_NEWS_CYCLE_MINUTES: v,
    });
    expect(p.env?.SIGNAL_NEWS_CYCLE_MINUTES).toBe(want);
    expect(p.warning).toBeNull();
  });

  it("defaults to 5 when not set", () => {
    const p = parseSignalEnv({ SIGNAL_RESEARCH_ENABLED: "true" });
    expect(p.env?.SIGNAL_NEWS_CYCLE_MINUTES).toBe(5);
    expect(p.warning).toBeNull();
  });

  it.each(["0", "6", "abc", "1.5", "-1", ""])(
    "%j falls back to 5 with a warning; the lane still runs (flag on)",
    (v) => {
      const p = parseSignalEnv({
        SIGNAL_RESEARCH_ENABLED: "true",
        SOSO_API_KEY: "k",
        DESK_AI_API_KEY: "c",
        SIGNAL_NEWS_CYCLE_MINUTES: v,
      });
      expect(p.env).not.toBeNull();
      expect(p.env?.SIGNAL_RESEARCH_ENABLED).toBe(true);
      expect(p.env?.SIGNAL_NEWS_CYCLE_MINUTES).toBe(5);
      expect(p.warning).toBe("invalid SIGNAL_NEWS_CYCLE_MINUTES, using 5");
      // Không bao giờ in giá trị.
      if (v !== "") expect(p.warning).not.toContain(`${v},`);
    },
  );

  it("a bad cycle next to another bad value: flag off ignores both, flag on stops the lane for the other one only", () => {
    const off = parseSignalEnv({ SIGNAL_NEWS_CYCLE_MINUTES: "9", SIGNAL_SOSO_MAX_PAGES: "10" });
    expect(off.env?.SIGNAL_NEWS_CYCLE_MINUTES).toBe(5);
    expect(off.warning).toMatch(/SIGNAL_SOSO_MAX_PAGES/);
    expect(off.warning).toMatch(/invalid SIGNAL_NEWS_CYCLE_MINUTES, using 5/);
    const on = parseSignalEnv({
      SIGNAL_RESEARCH_ENABLED: "1",
      SIGNAL_NEWS_CYCLE_MINUTES: "9",
      SIGNAL_SOSO_MAX_PAGES: "10",
    });
    expect(on.env).toBeNull();
    expect(on.warning).toMatch(/invalid SIGNAL_SOSO_MAX_PAGES/);
  });

  it.each([1, 5])("setInterval gets %i min in ms", (m) => {
    const calls: number[] = [];
    let ran = 0;
    const handle = scheduleNewsCycle(
      () => {
        ran += 1;
      },
      envOf({ SIGNAL_NEWS_CYCLE_MINUTES: String(m) }).SIGNAL_NEWS_CYCLE_MINUTES,
      (fn, ms) => {
        calls.push(ms);
        fn();
        return 0 as unknown as ReturnType<typeof setInterval>;
      },
    );
    expect(handle).toBe(0);
    expect(calls).toEqual([m * MIN]);
    expect(ran).toBe(1);
  });

  it("warns when the monthly SoSoValue limit runs out before month end at this cycle; never raises it", () => {
    expect(monthlyLimitWarning(envOf({}))).toBeNull(); // 5 phút: 8 928 / tháng < 9 500
    const one = envOf({ SIGNAL_NEWS_CYCLE_MINUTES: "1" });
    expect(one.SIGNAL_SOSO_MONTHLY_LIMIT).toBe(9_500);
    expect(monthlyLimitWarning(one)).toMatch(/below about 44640 requests a month/);
    expect(
      monthlyLimitWarning(
        envOf({ SIGNAL_NEWS_CYCLE_MINUTES: "1", SIGNAL_SOSO_MONTHLY_LIMIT: "60000" }),
      ),
    ).toBeNull();
  });
});

describe("Claude calls per cycle follow the cycle length", () => {
  it("50 per 5 min: 50 at 5 min, 10 at 1 min, so calls per hour stay 600", () => {
    expect(claudeCallsForCycle(50, 5)).toBe(50);
    expect(claudeCallsForCycle(50, 1)).toBe(10);
    expect(claudeCallsForCycle(50, 1) * 60).toBe(claudeCallsForCycle(50, 5) * 12);
    expect(claudeCallsForCycle(50, 3)).toBe(30);
    // Ít nhất 2 (một bài kể cả thử lại).
    expect(claudeCallsForCycle(1, 1)).toBe(2);
  });

  it("pipelineConfig uses the scaled value", () => {
    expect(pipelineConfig(envOf({})).claudeMaxCallsPerCycle).toBe(
      NEWS_LIMIT_DEFAULTS.claudeMaxCallsPerCycle,
    );
    expect(pipelineConfig(envOf({ SIGNAL_NEWS_CYCLE_MINUTES: "1" })).claudeMaxCallsPerCycle).toBe(
      10,
    );
    expect(
      pipelineConfig(
        envOf({ SIGNAL_NEWS_CYCLE_MINUTES: "1", SIGNAL_CLAUDE_MAX_CALLS_PER_CYCLE: "20" }),
      ).claudeMaxCallsPerCycle,
    ).toBe(4);
  });
});

describe("collect floor does not depend on the cycle", () => {
  it("1-minute cycles still look back 30 min from the last cycle (wall clock, not cycle count)", () => {
    const now = Date.parse("2026-11-21T12:00:00Z");
    const cfg = pipelineConfig(envOf({ SIGNAL_NEWS_CYCLE_MINUTES: "1" }));
    expect(collectFloor(now - 1 * MIN, now, cfg)).toBe(now - 30 * MIN);
    expect(collectFloor(now - 5 * MIN, now, cfg)).toBe(now - 30 * MIN);
  });
});

describe("source health thresholds follow the cycle", () => {
  it("SoSoValue Live = cycle + 2 min (5 → 7 min as before, 1 → 3 min); Delayed stays 20 min", () => {
    expect(sourceHealthOf("sosovalue", 5)).toEqual(SOURCE_HEALTH.sosovalue);
    expect(sourceHealthOf("sosovalue", null)).toEqual(SOURCE_HEALTH.sosovalue);
    expect(sourceHealthOf("sosovalue", 1)).toEqual({ liveMs: 3 * MIN, delayedMs: 20 * MIN });
    expect(sourceHealthOf("claude", 1)).toEqual(SOURCE_HEALTH.claude);
    expect(sourceHealthOf("sodex_prices", 1)).toEqual(SOURCE_HEALTH.sodex_prices);
  });

  it("status uses the real cycle: 4 min since the last success is Live at 5 min, Delayed at 1 min", () => {
    const now = Date.parse("2026-11-21T12:00:00Z");
    const ok = new Date(now - 4 * MIN);
    expect(sourceStatus("sosovalue", ok, null, now, null, 5)).toBe("live");
    expect(sourceStatus("sosovalue", ok, null, now, null, 1)).toBe("delayed");
    expect(sourceStatus("sosovalue", ok, null, now, null, null)).toBe("live");
  });

  it("rate_limited is Delayed (waiting on purpose), Down only after the Delayed threshold", () => {
    const now = Date.parse("2026-11-21T12:00:00Z");
    const err = new Date(now - 10_000);
    expect(sourceStatus("sosovalue", new Date(now - 10 * MIN), err, now, "rate_limited", 5)).toBe(
      "delayed",
    );
    expect(
      sourceStatus("sosovalue", new Date(now - 10 * MIN), err, now, "SoSoValue answered 500", 5),
    ).toBe("down");
    expect(sourceStatus("sosovalue", new Date(now - 25 * MIN), err, now, "rate_limited", 5)).toBe(
      "down",
    );
    // Thành công sau lần bị chặn: theo ngưỡng thường.
    expect(sourceStatus("sosovalue", new Date(now - 5_000), err, now, "rate_limited", 1)).toBe(
      "live",
    );
  });
});

describe("SoSoValue rate limit (20 requests a minute per key)", () => {
  it("blocks the 21st request in a sliding minute, allows again when the oldest leaves the window", () => {
    let t = 0;
    const l = new SosoRateLimiter(() => t);
    for (let i = 0; i < 20; i += 1) {
      expect(l.tryTake()).toBe(true);
      t += 1_000;
    }
    expect(l.inWindow()).toBe(20);
    expect(l.tryTake()).toBe(false);
    expect(l.inWindow()).toBe(20);
    t = 60_000; // request đầu (t = 0) rời cửa sổ
    expect(l.tryTake()).toBe(true);
    expect(l.tryTake()).toBe(false);
  });

  it("HTTP 429 and code 42901 are rate limits; other errors are not", async () => {
    const page = (status: number, body: unknown) =>
      sosoClient("k", () =>
        Promise.resolve(new Response(JSON.stringify(body), { status })),
      ).newsPage(1);
    const e429: unknown = await page(429, { code: 42901, message: "too many" }).catch(
      (e: unknown) => e,
    );
    expect(e429).toBeInstanceOf(SosoError);
    expect(isSosoRateLimited(e429)).toBe(true);
    const e42901: unknown = await page(200, { code: 42901, message: "too many" }).catch(
      (e: unknown) => e,
    );
    expect(isSosoRateLimited(e42901)).toBe(true);
    const e429NoBody: unknown = await page(429, "x").catch((e: unknown) => e);
    expect(isSosoRateLimited(e429NoBody)).toBe(true);
    const e500: unknown = await page(500, { code: 500 }).catch((e: unknown) => e);
    expect(isSosoRateLimited(e500)).toBe(false);
    expect(isSosoRateLimited(new Error("x"))).toBe(false);
  });

  it("reads X-RateLimit-Remaining when SoSoValue sends it", async () => {
    const body = { code: 0, data: { list: [] } };
    const withHeader = await sosoClient("k", () =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "X-RateLimit-Remaining": "0" },
        }),
      ),
    ).newsPage(1);
    expect(withHeader.rateRemaining).toBe(0);
    const without = await sosoClient("k", () =>
      Promise.resolve(new Response(JSON.stringify(body), { status: 200 })),
    ).newsPage(1);
    expect(without.rateRemaining).toBeNull();
  });
});

describe("sr:lane snapshot", () => {
  it("parses only a valid snapshot; TTL is 3 of the longest cycles", () => {
    const at = new Date().toISOString();
    expect(
      parseSrLane(JSON.stringify({ cycleMinutes: 1, sosoMonthlyLimit: 9500, updatedAt: at })),
    ).toEqual({ cycleMinutes: 1, sosoMonthlyLimit: 9500, updatedAt: at });
    expect(
      parseSrLane(JSON.stringify({ cycleMinutes: 0, sosoMonthlyLimit: 9500, updatedAt: at })),
    ).toBeNull();
    expect(parseSrLane("{x")).toBeNull();
    expect(parseSrLane(null)).toBeNull();
    expect(SR_LANE_TTL_MS).toBe(15 * MIN);
  });
});
