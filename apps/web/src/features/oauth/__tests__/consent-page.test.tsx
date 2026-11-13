// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { ConsentPage } from "../components/consent-page";

// Màn consent OAuth cho MCP (DEC-167, DEC-215): tên client không tin cậy luôn đi kèm host; chưa kết nối
// SoDEX thì không Allow được; Allow / Deny chuyển trình duyệt theo `redirect` của api.

const state = vi.hoisted(() => ({
  info: {},
  calls: [] as { method: string; path: string; body: unknown }[],
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () =>
    new URLSearchParams("client_id=dlc_x&redirect_uri=https%3A%2F%2Fclaude.example%2Fcb&state=s"),
}));
vi.mock("@/lib/api", () => ({
  ApiError: class extends Error {
    code = "X";
  },
  api: (method: string, path: string, _s: unknown, opts?: { body?: unknown }) => {
    state.calls.push({ method, path, body: opts?.body });
    if (method === "GET") return Promise.resolve(state.info);
    return Promise.resolve({ redirect: "https://claude.example/cb?code=abc" });
  },
}));

const assign = vi.fn();
beforeEach(() => {
  state.calls = [];
  assign.mockReset();
  Object.defineProperty(window, "location", { value: { assign }, writable: true });
});
afterEach(() => {
  cleanup();
});

const show = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <ConsentPage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );

describe("OAuth consent", () => {
  it("names the client with its real host, lists what it can do, and says it can't trade", async () => {
    state.info = {
      consent: {
        client: { name: "DeskLabs Official", host: "evil.example" },
        scopes: ["read"],
        denied: ["team:read"],
        needsSodex: false,
      },
    };
    const user = userEvent.setup({ delay: null });
    show();
    expect(await screen.findByText("DeskLabs Official")).toBeInTheDocument();
    expect(screen.getByText("evil.example")).toBeInTheDocument();
    expect(
      screen.getByText("Read your account, bots, decisions, AI Desk and Copy Trading data"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Not available for your account: Read DeskLabs team support data."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "This app can read your DeskLabs data. It can't place trades, change bots or move funds.",
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Allow" }));
    expect(state.calls.at(-1)).toMatchObject({
      method: "POST",
      body: { allow: true, client_id: "dlc_x", state: "s" },
    });
    expect(assign).toHaveBeenCalledWith("https://claude.example/cb?code=abc");
  });

  it("asks to connect SoDEX first and keeps Allow off, but Deny still works", async () => {
    state.info = {
      consent: {
        client: { name: null, host: "claude.ai" },
        scopes: [],
        denied: ["read"],
        needsSodex: true,
      },
    };
    const user = userEvent.setup({ delay: null });
    show();
    expect(await screen.findByText("Connect SoDEX first.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Allow" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Deny" }));
    expect(state.calls.at(-1)).toMatchObject({ body: { allow: false } });
  });

  it("returns to the client at once when the request itself was rejected", async () => {
    state.info = { redirect: "https://claude.example/cb?error=invalid_target" };
    show();
    await vi.waitFor(() => {
      expect(assign).toHaveBeenCalledWith("https://claude.example/cb?error=invalid_target");
    });
  });
});
