// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { EmailSignIn } from "../../auth/components/email-sign-in";
import { TwoFactorNudge } from "../components/connect-sodex";
import { StepHeading } from "../components/onboarding-shell";
import { alertsStepHref, safeNext, TelegramStep } from "../components/telegram-step";

// Onboarding W1 (báo cáo test 2026-11-13, DEC-202).

interface TestState {
  me: { twoFactorEnabled: boolean } | undefined;
  telegram: Record<string, unknown> | "disabled";
  next: string | null;
  replaced: string[];
}

const state: TestState = vi.hoisted(() => ({
  me: { twoFactorEnabled: false },
  telegram: { status: "not_connected" },
  next: "/bots/new/spot_grid?suggestion=abc",
  replaced: [],
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: (u: string) => {
      state.replaced.push(u);
    },
  }),
  useSearchParams: () => new URLSearchParams(state.next === null ? "" : `next=${state.next}`),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/queries", () => ({
  useMe: () => ({ data: state.me }),
  useFeatures: () => ({ data: { aiDesk: false } }),
}));
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...real,
    api: (_m: string, path: string) => {
      if (path === "/api/v1/telegram/link")
        return state.telegram === "disabled"
          ? Promise.reject(new real.ApiError("NOT_FOUND", 404))
          : Promise.resolve(state.telegram);
      if (path === "/api/v1/notifications/settings") return Promise.resolve({ groups: [] });
      return Promise.resolve(null);
    },
  };
});

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        {ui}
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.me = { twoFactorEnabled: false };
  state.telegram = { status: "not_connected" };
  state.next = "/bots/new/spot_grid?suggestion=abc";
  state.replaced = [];
});
afterEach(() => {
  cleanup();
});

describe("Create account form", () => {
  it("names the Risk Disclosure checkbox with its sentence, not 'on' (C12)", () => {
    wrap(<EmailSignIn mode="signup" />);
    expect(
      screen.getByRole("checkbox", { name: /I have read the Risk Disclosure/ }),
    ).toBeInTheDocument();
  });

  it("keeps Create account locked until the password meets both rules (C13)", async () => {
    const user = userEvent.setup({ delay: null });
    wrap(<EmailSignIn mode="signup" />);
    const submit = screen.getByRole("button", { name: "Create account" });
    await user.type(screen.getByLabelText("Email"), "maria.qa@example.com");
    await user.type(screen.getByLabelText("Password"), "my-maria.qa-pass");
    // Chứa phần trước @ của email → chưa đạt.
    expect(submit).toBeDisabled();
    await user.clear(screen.getByLabelText("Password"));
    await user.type(screen.getByLabelText("Password"), "correct horse battery");
    expect(submit).toBeEnabled();
  });

  it("clears an old error as soon as the user edits (C13)", async () => {
    const user = userEvent.setup({ delay: null });
    wrap(<EmailSignIn mode="signup" />);
    await user.type(screen.getByLabelText("Email"), "maria.qa@example.com");
    await user.type(screen.getByLabelText("Password"), "correct horse battery");
    // Chưa tích Risk Disclosure → lỗi.
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: /Risk Disclosure/ }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("no longer says 2FA is optional under the button (C14)", () => {
    wrap(<EmailSignIn mode="signup" />);
    expect(screen.queryByText(/Two-factor authentication is optional/)).toBeNull();
  });
});

describe("2FA nudge after Connect SoDEX (C14)", () => {
  it("offers Turn on 2FA and can be skipped", async () => {
    const user = userEvent.setup({ delay: null });
    wrap(<TwoFactorNudge />);
    expect(screen.getByRole("link", { name: "Turn on 2FA" })).toHaveAttribute(
      "href",
      "/settings?tab=security",
    );
    await user.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(screen.queryByRole("link", { name: "Turn on 2FA" })).toBeNull();
  });

  it("stays hidden when 2FA is already on", () => {
    state.me = { twoFactorEnabled: true };
    wrap(<TwoFactorNudge />);
    expect(screen.queryByRole("link", { name: "Turn on 2FA" })).toBeNull();
  });
});

describe("Step heading shows the step name (C11)", () => {
  it("adds the step name after STEP n OF 6", () => {
    wrap(<StepHeading step={2} title="Connect your SoDEX account" />);
    expect(screen.getByText(/STEP 2 OF 6/)).toHaveTextContent("STEP 2 OF 6 · Connect SoDEX");
  });
});

describe("Optional Telegram step", () => {
  it("only follows internal paths after the step (no open redirect)", () => {
    expect(safeNext("/bots/new/twap?suggestion=1")).toBe("/bots/new/twap?suggestion=1");
    expect(safeNext("https://evil.example")).toBe("/");
    expect(safeNext("//evil.example")).toBe("/");
    expect(safeNext("/\\evil.example")).toBe("/");
    expect(safeNext(null)).toBe("/");
    expect(alertsStepHref("/bots/new/twap?suggestion=1")).toBe(
      "/onboarding/alerts?next=%2Fbots%2Fnew%2Ftwap%3Fsuggestion%3D1",
    );
  });

  it("shows the Telegram card with Skip to where the user was going", async () => {
    wrap(<TelegramStep />);
    expect(await screen.findByRole("button", { name: "Connect Telegram" })).toBeInTheDocument();
    expect(screen.getByText("Optional")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Skip for now" })).toHaveAttribute(
      "href",
      "/bots/new/spot_grid?suggestion=abc",
    );
  });

  it("says Continue once Telegram is connected", async () => {
    state.telegram = { status: "active", username: "mai", connectedAt: "2026-11-13T01:00:00Z" };
    wrap(<TelegramStep />);
    expect(await screen.findByRole("link", { name: "Continue" })).toBeInTheDocument();
  });

  it("goes straight on when Telegram is off on the server", async () => {
    state.telegram = "disabled";
    wrap(<TelegramStep />);
    await vi.waitFor(() => {
      expect(state.replaced).toEqual(["/bots/new/spot_grid?suggestion=abc"]);
    });
    expect(screen.queryByRole("button", { name: "Connect Telegram" })).toBeNull();
  });
});
