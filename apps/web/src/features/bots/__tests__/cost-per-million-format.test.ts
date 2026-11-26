import { formatCostPerMillion } from "@drift/shared";
import { describe, expect, it } from "vitest";

import { formatAmount } from "@/lib/format";

// Trading Agent và tin Telegram khi bot dừng (#566) dùng chung `formatCostPerMillion`. Cùng bộ ví dụ với test của
// packages/shared và apps/jobs. Hàm chung phải cho đúng chuỗi mà Trading Agent đã hiện trước đây.
const CPM_EXAMPLES: readonly (readonly [string, string])[] = [
  ["201.61", "201.61"],
  ["201.6", "201.6"],
  ["50", "50"],
  ["20.16", "20.16"],
  ["0", "0"],
  ["1234.5", "1,234.5"],
  ["21778.85", "21,778.85"],
  ["3.456", "3.46"],
];

describe("cost per $1M format shared with Telegram", () => {
  it.each(CPM_EXAMPLES)("%s → %s", (v, text) => {
    expect(formatCostPerMillion(v)).toBe(text);
  });

  it("matches the Volume Builder KPI rule (formatAmount of 2 decimals)", () => {
    for (const [v] of CPM_EXAMPLES)
      expect(formatCostPerMillion(Number(v).toFixed(2))).toBe(
        formatAmount(Number(v).toFixed(2), null)?.text,
      );
  });

  it("matches the Market Making card's API string below 1,000 (API rounds to 2 decimals)", () => {
    for (const v of ["201.61", "201.6", "50", "20.16", "0"])
      expect(formatCostPerMillion(v)).toBe(v);
  });
});
