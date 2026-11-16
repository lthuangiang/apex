// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { LandingPage } from "../components/landing-page";

// Landing UI mới (docs/mockups/landing-mcp, DEC trong PR #166): theme mặc định sáng + nút đổi theme có nhớ; phí theo
// FEE_TIERS / builderFeeRateOf; cam kết "Withdraw or transfer · Never"; ví dụ ghi "Example" / "Illustration"; số liệu
// công khai lỗi thì "Not available", không bao giờ 0.

vi.mock("../landing-fonts", () => ({ LANDING_FONTS: "" }));
const apiMock = vi.fn();
vi.mock("@/lib/api", () => ({ api: (...args: unknown[]) => apiMock(...args) as unknown }));

const KEY = "desklabs.landing.theme";

const show = (initialTheme: "light" | "dark" | null = null) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <LandingPage serverUrl="https://mcp.example.test/mcp" initialTheme={initialTheme} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
const shell = () => document.querySelector(".landing");
/** Phần tử phải có; không có thì test hỏng ngay với selector đó. */
function el(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`missing ${selector}`);
  return found;
}

async function expectNoAxeViolations() {
  // jsdom không tính được màu thật: tắt color-contrast như các test axe khác.
  const r = await axe.run(document.body, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

beforeEach(() => {
  apiMock.mockResolvedValue({ totalVolume: "12345678", botsLaunched: 321 });
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("landing theme", () => {
  it("starts light, switches to dark from the nav and remembers it", async () => {
    const user = userEvent.setup({ delay: null });
    show();
    expect(shell()).toHaveAttribute("data-theme", "light");
    await user.click(screen.getByRole("button", { name: "Switch to dark" }));
    expect(shell()).toHaveAttribute("data-theme", "dark");
    expect(window.localStorage.getItem(KEY)).toBe("dark");
    expect(screen.getByRole("button", { name: "Switch to light" })).toBeInTheDocument();
    cleanup();
    show();
    await waitFor(() => {
      expect(shell()).toHaveAttribute("data-theme", "dark");
    });
  });

  it("draws the saved dark theme on the first paint and keeps it in a cookie", async () => {
    const user = userEvent.setup({ delay: null });
    // Theme từ cookie (server đọc): đúng ngay lần vẽ đầu, không chớp sáng.
    show("dark");
    expect(shell()).toHaveAttribute("data-theme", "dark");
    await user.click(screen.getByRole("button", { name: "Switch to light" }));
    expect(document.cookie).toContain("desklabs_landing_theme=light");
  });

  it("still works when the browser blocks storage", async () => {
    const user = userEvent.setup({ delay: null });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    show();
    expect(shell()).toHaveAttribute("data-theme", "light");
    await user.click(screen.getByRole("button", { name: "Switch to dark" }));
    expect(shell()).toHaveAttribute("data-theme", "dark");
  });
});

describe("landing content", () => {
  it("has no accessibility violations in light and dark", async () => {
    const user = userEvent.setup({ delay: null });
    show();
    await screen.findByText("$12.35M");
    await expectNoAxeViolations();
    await user.click(screen.getByRole("button", { name: "Switch to dark" }));
    await expectNoAxeViolations();
  }, 30_000);

  it("lets keyboard users scroll the wide strategy tables on a phone", () => {
    // jsdom không có layout nên axe không thấy scrollable-region-focusable; e2e mobile-390 (p11-public) chạy axe thật.
    show();
    for (const [name, table] of [
      ["Strategy comparison", "How it trades"],
      ["More strategies", "What it does"],
    ] as const) {
      const box = screen.getByRole("region", { name });
      expect(box).toHaveAttribute("tabindex", "0");
      expect(box).toHaveClass("overflow-x-auto");
      expect(within(box).getByRole("table")).toHaveTextContent(table);
    }
  });

  it("keeps the safety promises and the SoDEX builder line", () => {
    show();
    expect(
      screen.getByText("On SoDEX mainnet · Powered by SoDEX Builder Code"),
    ).toBeInTheDocument();
    const promises = el('dl[aria-label="What DeskLabs can do on your account"]');
    expect(within(promises).getByText("Withdraw or transfer")).toBeInTheDocument();
    expect(within(promises).getByText("Never")).toBeInTheDocument();
  });

  it("labels the hero bot as an illustration and the Volume Builder round as an example", async () => {
    const user = userEvent.setup({ delay: null });
    show();
    expect(screen.getByText(/^Illustration\. In the app you see your own bot/)).toBeInTheDocument();
    const mm = screen.getByRole("tab", { name: /Market Making/ });
    expect(mm).toHaveAttribute("aria-selected", "true");
    mm.focus();
    await user.keyboard("{ArrowRight}");
    const vb = screen.getByRole("tab", { name: /Volume Builder/ });
    expect(vb).toHaveAttribute("aria-selected", "true");
    expect(vb).toHaveFocus();
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByText("Example")).toBeInTheDocument();
    // Hai bản biểu đồ (390 px và rộng hơn; CSS chọn một), cùng tên cho trình đọc màn hình.
    expect(
      within(panel).getAllByRole("img", { name: /^Example round: long entry at 1,817\.6/ }),
    ).toHaveLength(2);
    expect(screen.getByText(/^Example round\. In the app/)).toBeInTheDocument();
  });

  it("shows the Market Making fee tiers and one rate for the rest", () => {
    show();
    const rows = within(el("#fees"))
      .getAllByRole("row")
      .slice(1)
      .map((r) => r.textContent.replace(/\s+/g, " ").trim());
    expect(rows).toEqual([
      "Market MakingUnder $200K0.003%",
      "$200K to $1M0.002%",
      "$1M and up0.001%",
      "Volume BuilderOne rate0.005%",
      "Every other strategyOne rate0.01%",
    ]);
    expect(
      screen.getByText("Builder fee drops to 0.002% and 0.001% as your volume grows"),
    ).toBeInTheDocument();
  });

  it("shows Not available, never 0, when the public numbers fail to load", async () => {
    apiMock.mockRejectedValue(new Error("down"));
    show();
    const strip = screen.getByRole("region", { name: "Platform numbers" });
    await waitFor(() => {
      expect(within(strip).getAllByText("Not available")).toHaveLength(2);
    });
    expect(within(strip).queryByText("0")).toBeNull();
  });
});
