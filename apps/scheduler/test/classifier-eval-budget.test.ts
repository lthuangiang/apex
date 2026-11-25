import { dec, NEWS_CLASSIFIER } from "@drift/shared";
import { describe, expect, it } from "vitest";

import { overBudget, parseMaxUsd, usageUsd } from "../src/cli/eval-budget";
import { emptyUsage } from "../src/signal-research/classifier";

// #530: trần chi phí `--max-usd` của classifier-eval. Chỉ phần thuần, không gọi Claude.

describe("classifier-eval --max-usd", () => {
  it("prices usage with NEWS_CLASSIFIER.pricing (cache write 2x, cache read 0.1x of input)", () => {
    const u = {
      ...emptyUsage(),
      calls: 2,
      input: 1_000_000,
      cacheWrite: 1_000_000,
      cacheRead: 1_000_000,
      output: 1_000_000,
    };
    const p = NEWS_CLASSIFIER.pricing;
    const expected = dec(p.inputPerM)
      .plus(dec(p.inputPerM).times(p.cacheWriteMultiple))
      .plus(dec(p.inputPerM).times(p.cacheReadMultiple))
      .plus(dec(p.outputPerM));
    expect(usageUsd(u).toFixed()).toBe(expected.toFixed());
    // Haiku 4.5: 1 + 2 + 0.1 + 5.
    expect(usageUsd(u).toFixed()).toBe("8.1");
    expect(usageUsd(emptyUsage()).toFixed()).toBe("0");
  });

  it("parses the flag: missing = no cap; only a positive number is accepted", () => {
    expect(parseMaxUsd(null)).toEqual({ ok: true, value: null });
    const one = parseMaxUsd("1");
    expect(one.ok && one.value?.toFixed()).toBe("1");
    const half = parseMaxUsd(" 0.5 ");
    expect(half.ok && half.value?.toFixed()).toBe("0.5");
    for (const bad of ["0", "-1", "abc", "", "1e3", "$1"])
      expect(parseMaxUsd(bad)).toEqual({ ok: false });
  });

  it("stops only when the running cost goes above the cap; no cap never stops", () => {
    expect(overBudget(dec("0.99"), dec("1"))).toBe(false);
    expect(overBudget(dec("1"), dec("1"))).toBe(false);
    expect(overBudget(dec("1.0001"), dec("1"))).toBe(true);
    expect(overBudget(dec("1000"), null)).toBe(false);
  });

  it("checked after each call: the call that crosses the cap is the last one", () => {
    // Mỗi lần gọi đúng 0.0025 USD (1.2k input, 7.5k đọc cache, 110 output); trần 0.01: 4 lần = đúng trần (chạy tiếp), lần
    // thứ 5 vượt → dừng, không gọi lần thứ 6.
    const perCall = { ...emptyUsage(), calls: 1, input: 1200, cacheRead: 7500, output: 110 };
    let u = emptyUsage();
    let made = 0;
    for (let i = 0; i < 10; i += 1) {
      u = {
        calls: u.calls + 1,
        input: u.input + perCall.input,
        cacheWrite: 0,
        cacheRead: u.cacheRead + perCall.cacheRead,
        output: u.output + perCall.output,
      };
      made += 1;
      if (overBudget(usageUsd(u), dec("0.01"))) break;
    }
    expect(made).toBe(5);
    expect(usageUsd(u).toFixed()).toBe("0.0125");
    expect(usageUsd(u).gt("0.01")).toBe(true);
  });
});
