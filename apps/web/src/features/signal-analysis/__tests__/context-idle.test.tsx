// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import messages from "../../../../messages/en.json";
import { ContextPanel, type ContextPanelState } from "../research/context-panel";
import { claudeCostShown } from "../research/news-trace";

import { CTX_ETH } from "./context-fixtures";

// Hoạt cảnh CHỜ của khung 4 · Context (#343): luôn hiện, chuyển động nền, nhưng không bao giờ trông như một kết quả.

const TZ = "Asia/Ho_Chi_Minh";

// IntersectionObserver giả: giữ callback để test bắn "ra khỏi màn hình".
let ioCallback: ((e: { isIntersecting: boolean }[]) => void) | null = null;
class FakeIO {
  constructor(cb: (e: { isIntersecting: boolean }[]) => void) {
    ioCallback = cb;
  }
  observe() {
    return undefined;
  }
  disconnect() {
    return undefined;
  }
}

let visibility: DocumentVisibilityState = "visible";
beforeEach(() => {
  ioCallback = null;
  visibility = "visible";
  Object.defineProperty(window, "IntersectionObserver", {
    value: FakeIO,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(document, "visibilityState", { get: () => visibility, configurable: true });
});
afterEach(() => {
  cleanup();
});

function wrap(node: ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      {node}
    </NextIntlClientProvider>,
  );
}
const panelEl = (state: ContextPanelState, ctx = state === "shown" ? CTX_ETH : null) => (
  <ContextPanel state={state} context={ctx} asset="ETH" tz={TZ} playKey="k" />
);

async function noViolations() {
  const r = await axe.run(document.body, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  expect(r.violations.map((v) => v.id)).toEqual([]);
}

describe("Context panel idle animation", () => {
  it("idle: animated background, no number tag, no Yes / No badge, the waiting line, aria-hidden", async () => {
    wrap(panelEl("idle"));
    const p = screen.getByTestId("sr-ctx-panel");
    expect(p).toHaveAttribute("data-state", "idle");
    const idle = within(p).getByTestId("sr-idle");
    expect(idle).toHaveAttribute("aria-hidden", "true");
    expect(idle.textContent).toBe("");
    expect(p).toHaveTextContent("Waiting for the next signal");
    // Ngoài tiêu đề "4 · Context": không số, không Yes / No.
    const body = p.textContent.replace("4 · Context", "");
    expect(body).not.toMatch(/\b(Yes|No|Disagree)\b|\d/);
    // Không có khung kết quả nào.
    expect(within(p).queryByTestId("sr-ctx-h1")).toBeNull();
    // Whales, Funding, Price đều chuyển động; bập bênh ẩn trên điện thoại.
    expect(within(p).getByTestId("sr-idle-h2")).toHaveClass("max-md:hidden");
    await noViolations();
  });

  it("an article that stops before step 4 says so", () => {
    wrap(panelEl("notReached"));
    expect(screen.getByTestId("sr-ctx-panel")).toHaveTextContent(
      "This article stopped before step 4",
    );
    expect(screen.getByTestId("sr-idle")).toBeInTheDocument();
  });

  it("switches to the real result, then back to idle", () => {
    const r = wrap(panelEl("idle"));
    r.rerender(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        {panelEl("shown")}
      </NextIntlClientProvider>,
    );
    const p = screen.getByTestId("sr-ctx-panel");
    expect(p).toHaveAttribute("data-state", "shown");
    expect(within(p).queryByTestId("sr-idle")).toBeNull();
    expect(within(p).getByText("2 whales · +$1.4M Long")).toBeInTheDocument();
    r.rerender(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        {panelEl("idle")}
      </NextIntlClientProvider>,
    );
    expect(screen.getByTestId("sr-ctx-panel")).toHaveAttribute("data-state", "idle");
    expect(screen.getByTestId("sr-idle")).toBeInTheDocument();
  });

  it("reduced motion: every idle animation is motion-safe only, so nothing moves", () => {
    wrap(panelEl("idle"));
    const animated = screen.getByTestId("sr-idle").querySelectorAll("[class*='animate-']");
    expect(animated.length).toBeGreaterThanOrEqual(5);
    for (const el of animated) {
      const cls = el.getAttribute("class") ?? "";
      expect(cls).not.toMatch(/(^|\s)animate-/);
      expect(cls).toMatch(/motion-safe:animate-\[sr-idle-/);
    }
  });

  it("pauses when the panel leaves the screen or the tab is hidden", () => {
    wrap(panelEl("idle"));
    const idle = () => screen.getByTestId("sr-idle");
    expect(idle()).not.toHaveAttribute("data-paused");
    act(() => {
      ioCallback?.([{ isIntersecting: false }]);
    });
    expect(idle()).toHaveAttribute("data-paused");
    expect(idle()).toHaveClass("[&_*]:[animation-play-state:paused]");
    act(() => {
      ioCallback?.([{ isIntersecting: true }]);
    });
    expect(idle()).not.toHaveAttribute("data-paused");
    act(() => {
      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(idle()).toHaveAttribute("data-paused");
  });
});

describe("Claude cost shown (#343)", () => {
  it("$0 is a real number; Not available only without cost data", () => {
    expect(claudeCostShown(null)).toBeNull();
    expect(claudeCostShown({ usd: "0", articles: 0, unknown: 0 })).toBe("0");
    expect(claudeCostShown({ usd: "0", articles: 3, unknown: 3 })).toBeNull();
    expect(claudeCostShown({ usd: "0.03", articles: 5, unknown: 1 })).toBe("0.03");
  });
});
