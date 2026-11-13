// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { FirstVisit } from "../components/first-visit";

// Desk AI lần đầu (artboard B-Empty; báo cáo test B6, F26): một h1, ba nút có tên, ô nhập 2 dòng có nhãn.

vi.mock("@/lib/api", () => ({ api: () => new Promise(() => undefined) }));
vi.mock("../components/new-bot-chat", () => ({ NewBotChat: () => null }));

afterEach(() => {
  cleanup();
});

describe("Desk AI first visit", () => {
  it("has one h1, named suggestions and a labelled two-line box", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <FirstVisit />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Hi, I'm Desk AI");
    for (const name of [/^Start my first bot/, /^How does a bot work\?/, /^Is my money safe\?/])
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    const box = screen.getByLabelText("Or tell me in your own words");
    expect(box.tagName).toBe("TEXTAREA");
    expect(box).toHaveAttribute("rows", "2");
    expect(box).toHaveAttribute("placeholder", "e.g. I have 300 USDC and want small, steady gains");
    expect(screen.getByText("✓ I never place orders on my own")).toBeInTheDocument();
  });
});
