// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { ClaudeDraftBanner } from "../components/claude-draft";
import { ClaudeDraftCreate } from "../components/claude-draft-create";

// Bản nháp từ Claude (DEC-TBD-mcp-drafts): banner "From Claude" với giờ hết hạn theo múi giờ của người dùng; bản nháp
// không mở được (hết hạn, không tồn tại, của người khác, sai chiến lược) luôn cùng một câu và nút về Strategy Lab.

type Result = "gone" | "wrong_strategy" | "bot_change";
const draft = vi.hoisted((): { result: Result } => ({ result: "gone" }));
vi.mock("@/components/workspace-shell", () => ({
  WorkspaceShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock("@/lib/queries", () => ({ useMe: () => ({ data: { role: "user", timezone: "UTC" } }) }));
vi.mock("../components/create-bot", () => ({
  CreateBot: () => <p>create form</p>,
}));
vi.mock("@/lib/api", () => ({
  ApiError: class extends Error {},
  api: (_m: string, path: string) => {
    if (!path.startsWith("/api/v1/drafts/")) return new Promise(() => undefined);
    if (draft.result === "gone")
      return Promise.reject(new Error("This draft is no longer available."));
    return Promise.resolve({
      id: "00000000-0000-4000-8000-0000000000d1",
      strategy: draft.result === "wrong_strategy" ? "futures_grid" : "spot_grid",
      botId: draft.result === "bot_change" ? "00000000-0000-4000-8000-000000000009" : null,
      name: null,
      config: {},
      expiresAt: "2026-11-14T10:00:00Z",
    });
  },
}));

const wrap = (node: ReactNode) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        {node}
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );

afterEach(cleanup);

describe("Claude drafts", () => {
  it("shows the From Claude banner with the expiry in the user's time zone", async () => {
    const { container } = wrap(<ClaudeDraftBanner expiresAt="2026-11-14T10:00:00Z" />);
    expect(screen.getByText("From Claude")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Claude drafted these settings. Nothing changes until you review and save or start the bot yourself.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Draft expires Nov 14, 10:00:00.")).toBeInTheDocument();
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it.each(["gone", "wrong_strategy", "bot_change"] as const)(
    "a draft that can't be used (%s) shows one message and a way back",
    async (result) => {
      draft.result = result;
      const { container } = wrap(
        <ClaudeDraftCreate strategy="spot_grid" draftId="00000000-0000-4000-8000-0000000000d1" />,
      );
      expect(
        await screen.findByText(
          "This draft is no longer available. Drafts from Claude last 24 hours.",
        ),
      ).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Open Strategy Lab" })).toHaveAttribute(
        "href",
        "/bots",
      );
      expect(screen.queryByText("create form")).not.toBeInTheDocument();
      expect((await axe.run(container)).violations).toEqual([]);
    },
  );
});
