import { describe, expect, it } from "vitest";

import { NEWS_CLASSIFIER } from "../signal-research/rules";
import {
  articleClaudeUsage,
  claudeCostUsd,
  type ArticleUsageColumns,
} from "../signal-research/usage";

const ZERO = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };

describe("claudeCostUsd (#290)", () => {
  it("prices each token kind from NEWS_CLASSIFIER.pricing (Haiku 4.5: 1 / 5 USD per 1M, write 2×, read 0.1×)", () => {
    expect(claudeCostUsd({ ...ZERO, input: 1_000_000 }).toFixed()).toBe("1");
    expect(claudeCostUsd({ ...ZERO, output: 1_000_000 }).toFixed()).toBe("5");
    expect(claudeCostUsd({ ...ZERO, cacheWrite: 1_000_000 }).toFixed()).toBe("2");
    expect(claudeCostUsd({ ...ZERO, cacheRead: 1_000_000 }).toFixed()).toBe("0.1");
  });

  it("is exact in decimal: no float error on small counts", () => {
    // (512 + 0 × 2 + 4 635 × 0.1) × 1 / 1M + 118 × 5 / 1M = 975.5 / 1M + 590 / 1M
    expect(
      claudeCostUsd({ input: 512, cacheWrite: 0, cacheRead: 4635, output: 118 }).toFixed(),
    ).toBe("0.0015655");
    expect(claudeCostUsd({ input: 1, cacheWrite: 1, cacheRead: 1, output: 1 }).toFixed()).toBe(
      "0.0000081",
    );
    expect(claudeCostUsd(ZERO).toFixed()).toBe("0");
  });

  it("takes another price table", () => {
    // (100 + 100 × 1.25 + 100 × 0.1) × 3 / 1M + 100 × 15 / 1M = 705 / 1M + 1 500 / 1M
    const p = {
      inputPerM: "3",
      outputPerM: "15",
      cacheWriteMultiple: "1.25",
      cacheReadMultiple: "0.1",
    };
    expect(
      claudeCostUsd({ input: 100, cacheWrite: 100, cacheRead: 100, output: 100 }, p).toFixed(),
    ).toBe("0.002205");
  });

  it("rejects negative or fractional token counts", () => {
    expect(() => claudeCostUsd({ ...ZERO, input: -1 })).toThrow(RangeError);
    expect(() => claudeCostUsd({ ...ZERO, output: 1.5 })).toThrow(RangeError);
    expect(() => claudeCostUsd({ ...ZERO, cacheRead: Number.NaN })).toThrow(RangeError);
  });
});

describe("articleClaudeUsage (#290)", () => {
  const row: ArticleUsageColumns = {
    claudeCalls: 1,
    claudeInputTokens: 512,
    claudeCacheWriteTokens: 0,
    claudeCacheReadTokens: 4635,
    claudeOutputTokens: 118,
    claudeModel: NEWS_CLASSIFIER.model,
    claudePromptVersion: NEWS_CLASSIFIER.promptVersion,
  };

  it("returns tokens and $ for a stored article", () => {
    expect(articleClaudeUsage(row)).toEqual({
      calls: 1,
      tokens: { input: 512, cacheWrite: 0, cacheRead: 4635, output: 118 },
      model: NEWS_CLASSIFIER.model,
      promptVersion: NEWS_CLASSIFIER.promptVersion,
      costUsd: "0.0015655",
    });
  });

  it("old rows and articles that never reached Claude are null (Not available), never 0", () => {
    expect(
      articleClaudeUsage({
        claudeCalls: null,
        claudeInputTokens: null,
        claudeCacheWriteTokens: null,
        claudeCacheReadTokens: null,
        claudeOutputTokens: null,
        claudeModel: null,
        claudePromptVersion: null,
      }),
    ).toBeNull();
  });

  it("unknown tokens: calls are kept, tokens and $ are null", () => {
    expect(
      articleClaudeUsage({
        ...row,
        claudeCalls: 2,
        claudeInputTokens: null,
        claudeOutputTokens: null,
      }),
    ).toMatchObject({ calls: 2, tokens: null, costUsd: null });
  });

  it("never prices a model that is not in the price table", () => {
    expect(articleClaudeUsage({ ...row, claudeModel: "claude-sonnet-4-5" })).toMatchObject({
      tokens: { input: 512 },
      costUsd: null,
    });
  });
});
