import { BotState, ReasonCode } from "@drift/shared";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { ComingSoonChip } from "../components/coming-soon-chip";
import { ConnectionStatus } from "../components/connection-status";
import { LastUpdated } from "../components/last-updated";
import { LiveBadge } from "../components/live-badge";
import { StaleBadge } from "../components/stale-badge";
import { StatusPill } from "../components/status-pill";

import { at } from "./fixtures";

const meta: Meta = { title: "Status/Badges" };
export default meta;
type Story = StoryObj;

export const Live: Story = { render: () => <LiveBadge label="LIVE · MAINNET" /> };

export const ComingSoon: Story = { render: () => <ComingSoonChip label="Paper · Coming soon" /> };

export const Connection: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <ConnectionStatus state="connecting" label="Connecting" />
      <ConnectionStatus state="connected" label="Connected" />
      <ConnectionStatus state="disconnected" label="Disconnected" />
    </div>
  ),
};

export const Updated: Story = {
  render: () => (
    <div className="flex flex-col items-start gap-3">
      <LastUpdated label="Updated" at={at} />
      <StaleBadge label="Stale" updatedAt={at} />
    </div>
  ),
};

/** Trạng thái chuyển tiếp, ổn định, bị pause kèm reason, và cần chú ý. */
export const BotStatus: Story = {
  render: () => (
    <div className="flex flex-col items-start gap-3">
      <StatusPill state={BotState.starting} label="Starting…" />
      <StatusPill state={BotState.running} label="Running" />
      <StatusPill
        state={BotState.paused}
        label="Paused"
        reason={ReasonCode.builderFeeRevoked}
        reasonLabel="Builder fee revoked"
      />
      <StatusPill
        state={BotState.running}
        label="Running"
        needsAttention
        needsAttentionLabel="Out of range"
      />
      <StatusPill
        state={BotState.stopped}
        label="Stopped"
        reason={ReasonCode.takeProfit}
        reasonLabel="Take profit"
      />
    </div>
  ),
};
