/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { NEWS_SIGNAL_LIVE_MAX_USDC } from "@drift/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { ModeSwitch, type ResearchMode } from "../mainnet/mainnet-panel";
import { DEFAULT_HOW_TAB, HowItWorksDrawer, type HowTab } from "../research/how-it-works";

// #454 (mockup docs/mockups/signal-research/mainnet-mode-colors.html): drawer How it works › Overview đọc chế độ của trang.
// Paper giữ bản cũ (player + sơ đồ một vòng chạy); Mainnet hiện bản gửi lệnh thật xuống SoDEX, có nhãn "Mainnet" ở tiêu đề,
// mục 1–4 "same as Paper" và 4 mục "mainnet". Tab Paper / Mainnet: chỉ tab đang chọn mang màu chế độ.

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...real,
    api: () => Promise.reject(new real.ApiError("NOT_FOUND", 404)),
  };
});

const intlErrors: string[] = [];
afterEach(() => {
  cleanup();
  intlErrors.length = 0;
});

function Wrap({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider
        locale="en"
        messages={messages}
        timeZone="UTC"
        onError={(e) => {
          intlErrors.push(e.message);
        }}
      >
        {children}
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
}

function Page({ start, cycleMinutes = 1 }: { start: ResearchMode; cycleMinutes?: number | null }) {
  const [mode, setMode] = useState<ResearchMode>(start);
  const [tab, setTab] = useState<HowTab | null>(null);
  return (
    <>
      <ModeSwitch mode={mode} onMode={setMode} />
      <button
        type="button"
        onClick={() => {
          setTab(DEFAULT_HOW_TAB);
        }}
      >
        How it works
      </button>
      <HowItWorksDrawer
        tab={tab}
        onTab={setTab}
        onClose={() => {
          setTab(null);
        }}
        version={null}
        rulesVersion={3}
        cycleMinutes={cycleMinutes}
        mode={mode}
      />
    </>
  );
}

async function open(start: ResearchMode, cycleMinutes: number | null = 1) {
  render(
    <Wrap>
      <Page start={start} cycleMinutes={cycleMinutes} />
    </Wrap>,
  );
  await userEvent.click(screen.getByRole("button", { name: "How it works" }));
  return screen.findByRole("dialog", { name: "How it works" });
}

describe("How it works › Overview by mode (#454)", () => {
  it("Paper keeps the fake-money overview and has no Mainnet tag", async () => {
    const dlg = await open("paper");
    expect(within(dlg).getByTestId("hiw-intro")).toHaveTextContent(/fake-money/);
    expect(within(dlg).getByTestId("hiw-player")).toBeInTheDocument();
    expect(within(dlg).queryByTestId("hiw-mainnet-list")).toBeNull();
    expect(within(dlg).queryByText("Mainnet")).toBeNull();
    expect(intlErrors).toEqual([]);
  });

  it("Mainnet shows real orders on SoDEX, the tag, the shared steps and the mainnet items", async () => {
    const dlg = await open("mainnet");
    const intro = within(dlg).getByTestId("hiw-intro");
    expect(intro).toHaveTextContent(
      "Every minute DeskLabs reads new crypto news, keeps articles about a coin listed on SoDEX, asks Claude what kind of news it is, then your mainnet bot decides whether to send a real order to SoDEX from your account. TP and SL are orders on SoDEX. DeskLabs never withdraws or transfers.",
    );
    expect(within(dlg).queryByTestId("hiw-player")).toBeNull();
    expect(within(dlg).getByText("Mainnet")).toBeInTheDocument();
    const svg = within(dlg).getByRole("img", { name: "Diagram of one mainnet run" });
    expect(svg).toHaveTextContent("send a real order to SoDEX");
    expect(svg).toHaveTextContent("SoDEX · your account");
    expect(svg).toHaveTextContent(
      "SoDEX: real orders from your account. Withdraw or transfer: never.",
    );
    expect(svg).toHaveTextContent(`≤ ${NEWS_SIGNAL_LIVE_MAX_USDC} USDC · 1× isolated`);
    const list = within(dlg).getByTestId("hiw-mainnet-list");
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(5);
    expect(items[0]).toHaveTextContent("1–4 · Collect, Normalize, Score, Context");
    expect(items[0]).toHaveTextContent("same as Paper");
    expect(within(list).getAllByText("mainnet")).toHaveLength(4);
    expect(items[1]).toHaveTextContent("size at most 200 USDC");
    expect(items[2]).toHaveTextContent("Builder fee 0.01% applies to each fill.");
    expect(intlErrors).toEqual([]);
  });

  it("follows the mode switch while the page is open", async () => {
    const user = userEvent.setup();
    render(
      <Wrap>
        <Page start="paper" />
      </Wrap>,
    );
    await user.click(screen.getByRole("radio", { name: "Mainnet" }));
    await user.click(screen.getByRole("button", { name: "How it works" }));
    const dlg = await screen.findByRole("dialog", { name: "How it works" });
    expect(within(dlg).getByTestId("hiw-mainnet-list")).toBeInTheDocument();
  });

  it("says Not available when the cycle is unknown", async () => {
    const dlg = await open("mainnet", null);
    expect(within(dlg).getByTestId("hiw-intro")).toHaveTextContent("how often: Not available");
  });

  it("has no axe violations in Mainnet", async () => {
    await open("mainnet");
    const r = await axe.run(document.body, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
      rules: { "color-contrast": { enabled: false } },
    });
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });
});

describe("ModeSwitch tones (#454)", () => {
  it("colors the selected tab by mode: Paper orange, Mainnet green", () => {
    render(
      <Wrap>
        <ModeSwitch mode="paper" onMode={() => undefined} />
      </Wrap>,
    );
    expect(screen.getByRole("radio", { name: "Paper" }).className).toContain(
      "data-[state=checked]:bg-warn-bg",
    );
    expect(screen.getByRole("radio", { name: "Mainnet" }).className).toContain(
      "data-[state=checked]:bg-pos",
    );
  });
});
