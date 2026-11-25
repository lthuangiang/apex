// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { BotDetail } from "@drift/shared";
import { act, cleanup, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { HoldLines, holdState, PositionLines } from "../components/agent-tiles";

// #527: ô Open orders (vị thế Long / Short + Unrealized) và ô Last decision (Hold N s + đếm ngược, Volume Builder).

const wrap = (node: ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <main>
        <dl>
          <dt>Tile</dt>
          <dd>{node}</dd>
        </dl>
      </main>
    </NextIntlClientProvider>,
  );
type Pos = Pick<BotDetail, "positionShown" | "position" | "pendingOrder" | "openOrders">;
const pos = (over: Partial<Pos>): Pos => ({
  positionShown: true,
  position: null,
  pendingOrder: null,
  openOrders: 0,
  ...over,
});
const AXE = { rules: { "color-contrast": { enabled: false } } };

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Open orders tile (#527)", () => {
  it("long: label, size at entry and positive unrealized", async () => {
    wrap(
      <PositionLines
        priceDigits={1}
        d={pos({
          openOrders: 1,
          position: {
            side: "long",
            qty: "0.03324",
            value: "55.38",
            avgEntry: "1666.2",
            markPrice: "1667.4",
            unrealizedPnl: "0.0399",
          },
        })}
      />,
    );
    expect(screen.getByText("Long")).toHaveClass("text-pos");
    expect(screen.getByText(/55\.38 USDC at 1,666\.2/)).toBeInTheDocument();
    expect(screen.getByText("Unrealized +0.04 USDC")).toHaveClass("text-pos");
    expect((await axe.run(document.body, AXE)).violations.map((v) => v.id)).toEqual([]);
  });

  it("short: label and negative unrealized", () => {
    wrap(
      <PositionLines
        priceDigits={1}
        d={pos({
          position: {
            side: "short",
            qty: "0.0426",
            value: "71.1",
            avgEntry: "1668",
            markPrice: "1670.6",
            unrealizedPnl: "-0.11076",
          },
        })}
      />,
    );
    expect(screen.getByText("Short")).toHaveClass("text-neg");
    expect(screen.getByText(/71\.10 USDC at 1,668\.0/)).toBeInTheDocument();
    expect(screen.getByText("Unrealized -0.11 USDC")).toHaveClass("text-neg");
  });

  it("no price: Not available, never 0", () => {
    wrap(
      <PositionLines
        priceDigits={1}
        d={pos({
          position: {
            side: "long",
            qty: "1",
            value: "100",
            avgEntry: "100",
            markPrice: null,
            unrealizedPnl: null,
          },
        })}
      />,
    );
    expect(screen.getByText("Not available")).toBeInTheDocument();
    expect(screen.queryByText(/Unrealized/)).not.toBeInTheDocument();
  });

  it("entry waiting, no position yet; nothing open: No open position", () => {
    const { unmount } = wrap(
      <PositionLines
        priceDigits={1}
        d={pos({ openOrders: 1, pendingOrder: { side: "buy", value: "55.38", price: "1666.2" } })}
      />,
    );
    expect(screen.getByText("Buy 55.38 USDC at 1,666.2")).toBeInTheDocument();
    expect(screen.getByText("No position yet")).toBeInTheDocument();
    unmount();
    wrap(<PositionLines priceDigits={1} d={pos({ openOrders: 0 })} />);
    expect(screen.getByText("No open position")).toBeInTheDocument();
    expect(screen.queryByText("No position yet")).not.toBeInTheDocument();
  });

  it("keeps the tile as before when the position is not shown (multi-ledger, stopped…)", () => {
    const { container } = wrap(
      <PositionLines priceDigits={1} d={pos({ positionShown: false, openOrders: 3 })} />,
    );
    expect(container.querySelector("dd")).toBeEmptyDOMElement();
  });
});

describe("Last decision tile: hold countdown (#527, Volume Builder)", () => {
  const T0 = Date.parse("2026-11-25T10:00:00Z");
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  const iso = (ms: number) => new Date(ms).toISOString();

  it("entry placed, not filled: Hold N s, Starts when filled", () => {
    wrap(
      <HoldLines
        hold={{ phase: "entering", holdSecs: 172, openedAt: null, holdUntil: null }}
        serverTime={iso(T0)}
        receivedAt={T0}
      />,
    );
    expect(screen.getByText("Hold 172 s")).toBeInTheDocument();
    expect(screen.getAllByText("Starts when filled").length).toBeGreaterThan(0);
  });

  it("filled: counts down every second to holdUntil, never below 0, then Hold finished · exiting", async () => {
    // Đồng hồ máy chậm hơn server 5 s: đếm theo giờ server.
    wrap(
      <HoldLines
        hold={{
          phase: "open",
          holdSecs: 172,
          openedAt: iso(T0 - 48_000),
          holdUntil: iso(T0 + 124_000),
        }}
        serverTime={iso(T0 + 5_000)}
        receivedAt={T0}
      />,
    );
    expect(screen.getByTestId("hold-left")).toHaveTextContent("119 s left");
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(screen.getByTestId("hold-left")).toHaveTextContent("116 s left");
    // Số đếm không nằm trong vùng aria-live (không đọc lại mỗi giây).
    expect(screen.getByTestId("hold-left").closest("[aria-live]")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(116_000);
    });
    expect(screen.queryByTestId("hold-left")).not.toBeInTheDocument();
    expect(screen.getAllByText("Hold finished · exiting").length).toBeGreaterThan(0);
    vi.useRealTimers();
    expect((await axe.run(document.body, AXE)).violations.map((v) => v.id)).toEqual([]);
  });

  it("state rules: early exit before holdUntil shows nothing; clock never negative", () => {
    const hold = {
      phase: "exiting" as const,
      holdSecs: 60,
      openedAt: iso(T0),
      holdUntil: iso(T0 + 60_000),
    };
    expect(holdState(hold, T0 + 10_000)).toBe("none");
    expect(holdState(hold, T0 + 61_000)).toBe("finished");
    expect(holdState({ ...hold, phase: "open" }, T0 + 10_000)).toBe("counting");
    const { container } = wrap(<HoldLines hold={hold} serverTime={iso(T0)} receivedAt={T0} />);
    expect(container.querySelector("dd")).toBeEmptyDOMElement();
  });

  it("other strategies (no hold): nothing", () => {
    const { container } = wrap(<HoldLines hold={null} serverTime={iso(T0)} receivedAt={T0} />);
    expect(container.querySelector("dd")).toBeEmptyDOMElement();
  });
});
