import { describe, expect, it } from "vitest";

import { formatCostPerMillion } from "../format";

// Cùng bộ ví dụ với test của web (Trading Agent) và jobs (tin Telegram khi bot dừng, #566).
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

describe("formatCostPerMillion", () => {
  it.each(CPM_EXAMPLES)("%s → %s", (v, text) => {
    expect(formatCostPerMillion(v)).toBe(text);
  });
});
