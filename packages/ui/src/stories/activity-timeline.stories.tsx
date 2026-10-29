import type { Meta, StoryObj } from "@storybook/react-vite";

import { ActivityTimeline } from "../components/activity-timeline";

import { at, noop } from "./fixtures";

const meta: Meta<typeof ActivityTimeline> = {
  title: "Data/ActivityTimeline",
  component: ActivityTimeline,
  args: {
    label: "Decisions & actions",
    status: "ready",
    empty: { title: "No activity yet" },
    error: { title: "Could not load activity", retryLabel: "Retry", onRetry: noop },
    items: [
      { id: "1", at, title: "Placed 12 grid orders", tone: "pos", toneLabel: "Placed" },
      {
        id: "2",
        at,
        title: "Order result unknown",
        description: "Checking with SoDEX",
        tone: "unknown",
        toneLabel: "Unknown",
      },
      {
        id: "3",
        at,
        title: "Order rejected",
        description: "Below min size",
        tone: "neg",
        toneLabel: "Rejected",
      },
    ],
  },
};
export default meta;
type Story = StoryObj<typeof ActivityTimeline>;

export const Loading: Story = { args: { status: "loading" } };
export const Empty: Story = { args: { status: "empty" } };
export const Error: Story = { args: { status: "error" } };
export const Stale: Story = { args: { stale: { label: "Stale", updatedAt: at } } };
