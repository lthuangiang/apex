// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { DeskHomeView } from "@drift/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";

// Hotfix bão request (#28): thẻ Needs you tự bấm Compare tối đa một lần cho mỗi lần trang chủ tải (`checkedAt`); lỗi
// (ví dụ 429) thì dừng, hiện nút bấm tay, không tự thử lại.

const posts: string[] = [];
const api = vi.hoisted(() => ({ fail: false }));
vi.mock("@/lib/api", () => ({
  ApiError: class extends Error {},
  api: (method: string, path: string) => {
    if (method === "POST") {
      posts.push(path);
      if (api.fail) return Promise.reject(new Error("429"));
      return Promise.resolve({
        id: "00000000-0000-4000-8000-0000000000aa",
        itemId: "00000000-0000-4000-8000-000000000001",
        botId: "00000000-0000-4000-8000-000000000002",
        bot: { name: "BTC Farm", strategy: "volume_farm", market: "BTC-USD", state: "running" },
        rule: "liquidation_before_stop",
        status: "queued",
        source: null,
        windowFrom: "2026-11-05T00:00:00.000Z",
        windowTo: "2026-11-12T00:00:00.000Z",
        botVersion: 1,
        options: [],
        pick: null,
        error: null,
      });
    }
    return new Promise(() => undefined);
  },
}));

const { NeedsYouCard } = await import("../components/needs-you-card");

const item: DeskHomeView["items"][number] = {
  id: "00000000-0000-4000-8000-000000000001",
  botId: "00000000-0000-4000-8000-000000000002",
  botName: "BTC Farm",
  strategy: "volume_farm",
  market: "BTC-USD",
  rule: "liquidation_before_stop",
  severity: 3,
  facts: [],
  whatif: null,
};

let qc: QueryClient;
const wrap = (node: ReactNode) => (
  <QueryClientProvider client={qc}>
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      {node}
    </NextIntlClientProvider>
  </QueryClientProvider>
);

beforeEach(() => {
  posts.length = 0;
  api.fail = false;
  qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});
afterEach(() => {
  cleanup();
});

describe("Needs you card auto-compare", () => {
  it("asks once per home load, not again when the request settles or the home refetches with the same checkedAt", async () => {
    const view = render(wrap(<NeedsYouCard item={item} checkedAt="t1" />));
    await waitFor(() => {
      expect(posts).toHaveLength(1);
    });
    // Request đã xong (không còn pending): không được bấm lại.
    await new Promise((r) => setTimeout(r, 200));
    expect(posts).toHaveLength(1);
    view.rerender(wrap(<NeedsYouCard item={item} checkedAt="t1" />));
    await new Promise((r) => setTimeout(r, 50));
    expect(posts).toHaveLength(1);
    // Trang chủ tải lại (checkedAt mới) mà vẫn chưa có so sánh: bấm thêm một lần.
    view.rerender(wrap(<NeedsYouCard item={item} checkedAt="t2" />));
    await waitFor(() => {
      expect(posts).toHaveLength(2);
    });
  });

  it("stops after an error, shows it, and only asks again when the user taps Compare again", async () => {
    api.fail = true;
    const view = render(wrap(<NeedsYouCard item={item} checkedAt="t1" />));
    expect(await screen.findByText("Couldn’t compare right now.")).toBeInTheDocument();
    expect(posts).toHaveLength(1);
    view.rerender(wrap(<NeedsYouCard item={item} checkedAt="t2" />));
    await new Promise((r) => setTimeout(r, 50));
    expect(posts).toHaveLength(1);
    api.fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Compare again" }));
    await waitFor(() => {
      expect(posts).toHaveLength(2);
    });
  });
});

describe("Needs you card: bot needs attention (#472)", () => {
  const attention = (facts: DeskHomeView["items"][number]["facts"]) => ({
    ...item,
    botName: "Stock Monitor",
    strategy: "news_signal",
    market: "",
    rule: "bot_needs_attention" as const,
    severity: 2,
    facts,
  });
  const fact = (name: string, value: string) => ({
    id: `b:${name}`,
    name,
    value,
    unit: "text" as const,
    source: "bot_state" as const,
  });

  it("shows the title, the reason label and Open bot, with no what-if", async () => {
    render(
      wrap(
        <main>
          <NeedsYouCard
            item={attention([fact("state", "paused"), fact("reasonCode", "BOT_MAX_LOSS")])}
            checkedAt="t1"
          />
        </main>,
      ),
    );
    expect(
      screen.getByRole("heading", { name: "Stock Monitor needs your attention" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Check the bot’s recent decisions.")).toBeNull();
    expect(screen.getByRole("link", { name: "Open bot" })).toHaveAttribute(
      "href",
      `/agent/${item.botId ?? ""}`,
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(posts).toHaveLength(0);
    const r = await axe.run(document.body, { rules: { "color-contrast": { enabled: false } } });
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });

  it("no reason (or a code without a label) uses the fallback sentence", () => {
    const view = render(
      wrap(<NeedsYouCard item={attention([fact("state", "running")])} checkedAt="t1" />),
    );
    expect(screen.getByText("Check the bot’s recent decisions.")).toBeInTheDocument();
    view.unmount();
    render(
      wrap(
        <NeedsYouCard
          item={attention([fact("state", "paused"), fact("reasonCode", "SOMETHING_NEW")])}
          checkedAt="t1"
        />,
      ),
    );
    expect(screen.getByText("Check the bot’s recent decisions.")).toBeInTheDocument();
    expect(screen.queryByText("SOMETHING_NEW")).toBeNull();
  });
});
