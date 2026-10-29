import type { Meta, StoryObj } from "@storybook/react-vite";

import { BacktestPanel } from "../components/backtest-panel";

import { at, noop } from "./fixtures";

const meta: Meta<typeof BacktestPanel> = {
  title: "Special/BacktestPanel",
  component: BacktestPanel,
  args: {
    title: "Backtest",
    disclaimer: "Simulated on past prices. Not a forecast; future results will differ.",
    status: "ready",
    runLabel: "Run backtest",
    onRun: noop,
    emptyTitle: "Not run yet",
    errorTitle: "Backtest failed",
    missingLabel: "Not available",
    metrics: [
      { label: "Net PnL", value: "+12.40 USDC" },
      { label: "Max drawdown", value: "-3.1%" },
      { label: "Trades", value: "148" },
      { label: "Fees", value: null },
    ],
  },
};
export default meta;
type Story = StoryObj<typeof BacktestPanel>;

export const Loading: Story = {
  args: {
    status: "loading",
    progress: { label: "Simulating 129,600 one-minute candles…", percent: 42 },
  },
};
export const Empty: Story = { args: { status: "empty" } };
export const Error: Story = { args: { status: "error" } };
export const Stale: Story = {
  args: { stale: { label: "Out of date · run again", updatedAt: at } },
};
export const Unavailable: Story = {
  args: { status: "empty", unavailableReason: "Backtest unavailable for this market" },
};
