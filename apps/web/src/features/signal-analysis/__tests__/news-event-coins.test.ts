import { researchArticleTraceSchema } from "@drift/shared";
import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";

import messages from "../../../../messages/en.json";
import type { Tr } from "../research/text";
import { reached, traceView } from "../research/trace-text";

import {
  EVENT_FIRST,
  EVENT_FIRST_TRACE,
  EVENT_REPOST_TRACE,
  SAME_DAY_REPOST_TRACE,
} from "./news-event-fixtures";
import { ETH, ETH_TRACE } from "./news-trace-fixtures";

// #530 (news-v6) PR3: trace của sự kiện tin nêu nhiều coin và bài đăng lại "Same event"
// (docs/mockups/signal-research/news-event-coins.html).

const t = createTranslator({
  locale: "en",
  messages,
  namespace: "signalAnalysis.research" as never,
}) as unknown as Tr;

const step = (tr: Parameters<typeof traceView>[0], key: string) => {
  const s = traceView(tr, "UTC", t).steps.find((x) => x.key === key);
  if (s === undefined) throw new Error(key);
  return s;
};

describe("multi-coin news event: first article (#530)", () => {
  it("fixtures pass the shared API schema", () => {
    expect(() => researchArticleTraceSchema.parse(EVENT_FIRST_TRACE)).not.toThrow();
    expect(() => researchArticleTraceSchema.parse(EVENT_REPOST_TRACE)).not.toThrow();
  });

  it("Normalize band lists every candidate market, not only the story market", () => {
    expect(step(EVENT_FIRST_TRACE, "normalize").band).toBe(
      "AAVE-USD, LINK-USD, UNI-USD · new story",
    );
    // Một coin: như cũ, market của câu chuyện.
    expect(step(ETH_TRACE, "normalize").band).toBe("ETH-USD · new story");
  });

  it("Score lists every coin of the event as the asset", () => {
    expect(step(EVENT_FIRST_TRACE, "score").rows.find((r) => r.label === "Asset")?.value).toBe(
      "AAVE-USD, LINK-USD, UNI-USD",
    );
  });

  it("Filter: '2 of 3 coins passed', checked each coin on its own, one group per coin", () => {
    const f = step(EVENT_FIRST_TRACE, "filter");
    expect(f.band).toBe("2 of 3 coins passed");
    expect(f.summary).toBe("Checked each coin on its own.");
    expect(f.groups?.map((g) => g.title)).toEqual(["AAVE-USD", "LINK-USD", "UNI-USD"]);
    const uni = f.groups?.[2]?.rows ?? [];
    expect(uni.find((r) => r.label === "Take profit vs cost")?.value).toBe(
      "0.15% vs 2 × 0.10% = 0.20%",
    );
    expect(uni.find((r) => r.label === "Result")?.value).toBe("Dropped: Take profit under 2× cost");
    // Mã nội bộ chỉ ở tooltip.
    expect(uni.find((r) => r.label === "Result")?.title).toBe("MOVE_TOO_SMALL_FOR_COST");
    // Một coin vẫn đếm kiểm: "4 of 4 checks".
    expect(step(ETH_TRACE, "filter").band).toBe("4 of 4 checks");
  });

  it("Decide: 'Long 166.66 USDC × 2', one row per coin and the size split line", () => {
    const d = step(EVENT_FIRST_TRACE, "decide");
    expect(d.band).toBe("Long 166.66 USDC × 2");
    expect(d.summary).toBe("Opened paper trades on the News bot.");
    expect(d.note).toBe("Size split across 3 coins from one event.");
    expect(d.rows.map((r) => [r.label, r.value])).toEqual([
      ["AAVE-USD", "Long AAVE-USD · 166.66 USDC"],
      ["LINK-USD", "Long LINK-USD · 166.66 USDC"],
      ["UNI-USD", "Dropped: Take profit under 2× cost"],
    ]);
  });

  it("one trade keeps the old Decide band and has no split line", () => {
    const d = step(ETH_TRACE, "decide");
    expect(d.band).toBe("Long 500 USDC");
    expect(d.note).toBeUndefined();
    expect(d.summary).toBe("Opened a paper trade on the News bot.");
  });

  it("verdict names every trade; chip and token list every traded coin", () => {
    const v = traceView(EVENT_FIRST_TRACE, "UTC", t);
    expect(v.verdict).toBe(
      "Reached Decide: Long AAVE-USD, 166.66 USDC · Long LINK-USD, 166.66 USDC",
    );
    expect(v.tradedAssets).toBe("AAVE-USD, LINK-USD");
    expect(reached(EVENT_FIRST, t).text).toBe("Long AAVE-USD, LINK-USD · paper trade");
    expect(reached(ETH, t).text).toBe("Long ETH · paper trade");
  });
});

describe("below the SoDEX minimum (#530)", () => {
  it("verdict uses the lower-case reason; the Filter card explains it", () => {
    const tr = {
      ...EVENT_REPOST_TRACE,
      event: null,
      steps: EVENT_REPOST_TRACE.steps.map((s) =>
        s.key === "filter"
          ? { ...s, reason: "belowMinSize" as const, code: "BELOW_MIN_ORDER_SIZE" }
          : s,
      ),
    };
    expect(traceView(tr, "UTC", t).verdict).toBe(
      "Stopped at Filter: this coin's share of the event is below the SoDEX minimum order size",
    );
    expect(step(tr, "filter").summary).toBe(
      "This coin's share of the event is below the SoDEX minimum order size.",
    );
  });
});

describe("repost of a handled event: Same event (#530)", () => {
  it("Filter stops with 'Same event', explains it and points to the first article with its date", () => {
    const f = step(EVENT_REPOST_TRACE, "filter");
    expect(f.band).toBe("Same event");
    expect(f.summary).toBe("This article repeats an event that was already handled.");
    expect(f.rows[0]).toEqual({
      label: "First article",
      value: "A major broker adds AAVE, LINK and UNI trading (Nov 24 15:35)",
    });
    // Theo thứ tự bài nêu: COMP trước (không có story → Same event), AAVE sau (story khoá → gộp).
    expect(f.groups?.map((g) => [g.title, g.rows.at(-1)?.value])).toEqual([
      ["COMP-USD", "Dropped: Same event"],
      ["AAVE-USD", "Merged: joined a story already open"],
    ]);
  });

  it("verdict uses the lower-case reason", () => {
    expect(traceView(EVENT_REPOST_TRACE, "UTC", t).verdict).toBe(
      "Stopped at Filter: this article repeats an event that was already handled",
    );
  });

  it("first article on the same day shows the time only", () => {
    const f = step(SAME_DAY_REPOST_TRACE, "filter");
    expect(f.rows[0]?.value).toBe("A major broker adds AAVE, LINK and UNI trading (15:35)");
    expect(f.rows.at(-1)?.value).toBe("Dropped: Same event");
    expect(f.groups).toBeUndefined();
  });

  it("the date follows the viewer's time zone", () => {
    // 15:35 UTC ngày 24 = 22:35 ở UTC+7, bài đăng lại 01:30 UTC ngày 25 = 08:30 ngày 25: vẫn khác ngày.
    const f = traceView(EVENT_REPOST_TRACE, "Asia/Ho_Chi_Minh", t).steps.find(
      (x) => x.key === "filter",
    );
    expect(f?.rows[0]?.value).toBe("A major broker adds AAVE, LINK and UNI trading (Nov 24 22:35)");
  });
});
