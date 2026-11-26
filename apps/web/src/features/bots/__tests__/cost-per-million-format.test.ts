import { describe, expect, it } from "vitest";

import { formatAmount } from "@/lib/format";

// Chuỗi CPM mà Trading Agent đang hiện, theo từng chiến lược. Tin Telegram khi bot dừng (#566) chép đúng hai quy tắc này;
// apps/jobs/test/telegram-bot-stopped-render.test.ts dùng CÙNG bộ ví dụ, hai test phải cùng đổi.
// - Market Making (thẻ Market Making, agent-page.tsx): nguyên chuỗi `costPerMillion` của API.
// - Volume Builder (KPI "Net cost / $1M", volume-dashboard.tsx): `money(cpm, 2)` = formatAmount(toFixed(2), null).
const MM_CPM_EXAMPLES: readonly (readonly [string, string])[] = [
  ["201.61", "201.61"],
  ["201.6", "201.6"],
  ["50", "50"],
  ["0", "0"],
  ["1234.5", "1234.5"],
];
const VB_CPM_EXAMPLES: readonly (readonly [string, string])[] = [
  ["201.61", "201.61"],
  ["201.6", "201.6"],
  ["50", "50"],
  ["0", "0"],
  ["1234.5", "1,234.5"],
];

describe("cost per $1M as the Trading Agent shows it (kept in sync with the Telegram message)", () => {
  it.each(MM_CPM_EXAMPLES)("Market Making card: %s → %s", (v, text) => {
    // Thẻ hiện `{vm.costPerMillion ?? notAvailable}`: không định dạng lại.
    expect(v).toBe(text);
  });
  it.each(VB_CPM_EXAMPLES)("Volume Builder KPI: %s → %s", (v, text) => {
    expect(formatAmount(Number(v).toFixed(2), null)?.text).toBe(text);
  });
});
