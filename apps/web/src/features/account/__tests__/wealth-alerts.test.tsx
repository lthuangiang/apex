// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { ApiError } from "../../../lib/api";
import { WealthAlertsCard } from "../components/wealth-alerts";

// #594 (DEC-404 mục 7): công tắc "Alerts" ở My Wealth. Trạng thái lấy từ backend (quy tắc 6): công tắc chỉ đổi khi api
// trả lời, lúc chờ hiện câu chuyển tiếp. `/features.wealthAlerts` false (công tắc hệ thống tắt, không phải team) hoặc api
// 404 → không render. Câu chữ còn chờ duyệt nên test đọc từ en.json, không chép cứng.

const A = messages.myWealth.alerts;

interface Call {
  method: string;
  path: string;
  idempotencyKey: string | undefined;
}
interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

const state = vi.hoisted(() => ({
  wealthAlerts: true,
  get: { status: "off", lastCheckedAt: null, delayed: false },
  getError: null as Error | null,
  calls: [] as Call[],
  pending: [] as Pending[],
}));

vi.mock("@/components/workspace", () => ({
  Card: ({ title, children }: { title?: string; children: ReactNode }) => (
    <section aria-label={title}>
      {title === undefined ? null : <h2>{title}</h2>}
      {children}
    </section>
  ),
}));
vi.mock("@/lib/queries", () => ({
  useFeatures: () => ({ data: { usMarket: true, wealthAlerts: state.wealthAlerts } }),
}));
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../lib/api")>();
  return {
    ...real,
    api: (method: string, path: string, _schema: unknown, opts?: { idempotencyKey?: string }) => {
      state.calls.push({ method, path, idempotencyKey: opts?.idempotencyKey });
      if (method === "GET") {
        if (state.getError !== null) return Promise.reject(state.getError);
        return Promise.resolve(state.get);
      }
      return new Promise((resolve, reject) => {
        state.pending.push({ resolve, reject });
      });
    },
  };
});

function show() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <WealthAlertsCard />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.wealthAlerts = true;
  state.get = { status: "off", lastCheckedAt: null, delayed: false };
  state.getError = null;
  state.calls = [];
  state.pending = [];
});
afterEach(() => {
  cleanup();
});

describe("WealthAlertsCard", () => {
  it("is hidden and reads nothing when the feature is off for this user", () => {
    state.wealthAlerts = false;
    const { container } = show();
    expect(container).toBeEmptyDOMElement();
    expect(state.calls).toHaveLength(0);
  });

  it("is hidden when the api answers 404", async () => {
    state.getError = new ApiError("NOT_FOUND", 404, {});
    const { container } = show();
    await vi.waitFor(() => {
      expect(state.calls).toHaveLength(1);
    });
    expect(container).toBeEmptyDOMElement();
  });

  it("turning on: POST with an Idempotency-Key, 'Turning on…' until the backend answers", async () => {
    show();
    const sw = await screen.findByRole("switch", { name: A.toggle });
    expect(sw).not.toBeChecked();
    fireEvent.click(sw);
    await screen.findByText(A.turningOn);
    const post = state.calls.find((c) => c.method === "POST");
    expect(post?.path).toBe("/api/v1/wealth/watch");
    expect(post?.idempotencyKey).toBeTruthy();
    // Chưa có xác nhận: công tắc chưa đổi, đang khoá.
    expect(screen.getByRole("switch", { name: A.toggle })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: A.toggle })).toBeDisabled();
    state.get = { status: "active", lastCheckedAt: null, delayed: false };
    await act(async () => {
      state.pending[0]?.resolve({ status: "active", lastCheckedAt: null, delayed: false });
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(screen.getByRole("switch", { name: A.toggle })).toBeChecked();
    });
  });

  it("turning off sends DELETE; a failure keeps the switch on and says so", async () => {
    state.get = { status: "active", lastCheckedAt: null, delayed: false };
    show();
    const sw = await screen.findByRole("switch", { name: A.toggle });
    await vi.waitFor(() => {
      expect(sw).toBeChecked();
    });
    fireEvent.click(sw);
    await screen.findByText(A.turningOff);
    expect(state.calls.find((c) => c.method === "DELETE")?.path).toBe("/api/v1/wealth/watch");
    await act(async () => {
      state.pending[0]?.reject(new ApiError("INTERNAL_ERROR", 500, {}));
      await Promise.resolve();
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(A.failed);
    expect(screen.getByRole("switch", { name: A.toggle })).toBeChecked();
  });

  it("shows a delay note when recent reads were pushed back", async () => {
    state.get = { status: "active", lastCheckedAt: null, delayed: true };
    show();
    expect(await screen.findByText(A.delayed)).toBeInTheDocument();
  });

  it("has no axe violations", async () => {
    show();
    await screen.findByRole("switch", { name: A.toggle });
    const r = await axe.run(document.body, { rules: { region: { enabled: false } } });
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });
});
