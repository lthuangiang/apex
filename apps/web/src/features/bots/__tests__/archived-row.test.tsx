// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { BotActions } from "../components/bot-actions";

// Bot archived xem được ở chế độ chỉ đọc (BD-01, DEC-263): hàng archived có View và Restore.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => undefined, push: () => undefined }),
}));
vi.mock("@/lib/queries", () => ({
  useSodexConnection: () => ({ data: undefined, isSuccess: false }),
}));
vi.mock("@/lib/api", () => ({ api: () => new Promise(() => undefined) }));

afterEach(() => {
  cleanup();
});

describe("archived bot row (BD-01)", () => {
  it("offers View to the read-only page next to Restore", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <BotActions
            bot={{
              id: "01a1ab7e-2236-76d7-b9a7-37aa8624c581",
              name: "Futures Grid · BTC",
              state: "archived",
              reasonCode: null,
            }}
          />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByRole("link", { name: "View" })).toHaveAttribute(
      "href",
      "/agent/01a1ab7e-2236-76d7-b9a7-37aa8624c581",
    );
    expect(screen.getByRole("button", { name: /Restore/ })).toBeInTheDocument();
  });
});
