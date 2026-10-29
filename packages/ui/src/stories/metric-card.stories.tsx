import type { Meta, StoryObj } from "@storybook/react-vite";

import { MetricCard } from "../components/metric-card";
import { PnLValue } from "../components/pnl-value";

import { at, noop } from "./fixtures";

const meta: Meta<typeof MetricCard> = {
  title: "Data/MetricCard",
  component: MetricCard,
  args: { label: "Net PnL", emptyLabel: "Not available" },
  decorators: [
    (Story) => (
      <div className="max-w-xs">
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof MetricCard>;

export const Loading: Story = { args: { status: "loading" } };
export const Empty: Story = { args: { status: "empty" } };
export const Error: Story = {
  args: { status: "error", errorLabel: "Could not load", retryLabel: "Retry", onRetry: noop },
};
export const Stale: Story = {
  args: {
    status: "ready",
    value: <PnLValue value="1284.52" locale="en-US" missingLabel="Not available" suffix=" USDC" />,
    stale: { label: "Stale", updatedAt: at },
  },
};
export const Ready: Story = {
  args: {
    status: "ready",
    value: <PnLValue value="-42.1" locale="en-US" missingLabel="Not available" suffix=" USDC" />,
  },
};
