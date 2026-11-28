// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { targetOf, type NotificationItem } from "../model";
import { useNotificationText } from "../text";

// #594 (DEC-404): tin SoDEX Wealth trong chuông: tên quỹ, loại, trạng thái, số tiền đúng như SoDEX trả; mở My Wealth.
// Câu chữ còn chờ duyệt: test kiểm dữ liệu, không chép câu. Không bao giờ có %.

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../lib/api")>();
  return { ...real, api: () => Promise.resolve({ items: [] }) };
});

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        {children}
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
}

const item = (type: NotificationItem["type"], data: Record<string, unknown>): NotificationItem =>
  ({
    id: "00000000-0000-4000-8000-000000000001",
    type,
    data,
    createdAt: "2026-11-28T08:00:00.000Z",
    readAt: null,
  }) as NotificationItem;

describe("SoDEX Wealth bell entries", () => {
  const { result } = renderHook(() => useNotificationText(), { wrapper });
  const text = (n: NotificationItem) => result.current(n);

  it("settled request: fund, status and the SoDEX amount", () => {
    const t = text(
      item("wealth_request_settled", {
        fundId: "fund-a",
        fundName: "Sample Fund A",
        what: "invest",
        status: "completed",
        cost: "1500.5",
        proceeds: null,
        shares: "3",
      }),
    );
    expect(t.title).toContain("Sample Fund A");
    expect(t.title).toContain(messages.notifications.panel.wealth.what.invest);
    expect(t.body).toContain("1,500.50");
    expect(`${t.title} ${t.body ?? ""}`).not.toContain("%");
  });

  it("recurring buy skipped: fund, date, amount; malformed data → generic title", () => {
    const t = text(
      item("wealth_recurring_issue", {
        fundId: "fund-a",
        fundName: null,
        status: "skipped",
        reasonCode: null,
        scheduledDate: "2026-11-28",
        amount: "25",
      }),
    );
    expect(t.title).toContain("fund-a");
    expect(t.body).toContain("2026-11-28");
    expect(t.body).toContain("25.00");
    expect(text(item("wealth_recurring_issue", {})).title).toBe(
      messages.notifications.types.wealth_recurring_issue,
    );
  });

  it("opens Portfolio › My Wealth", () => {
    expect(targetOf(item("wealth_request_settled", {}), false)).toBe("/portfolio?tab=wealth");
    expect(targetOf(item("wealth_recurring_issue", {}), true)).toBe("/portfolio?tab=wealth");
  });
});
