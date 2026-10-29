import type { Meta, StoryObj } from "@storybook/react-vite";

import { ChecklistRow } from "../components/checklist-row";
import { EmptyState } from "../components/empty-state";
import { ErrorState } from "../components/error-state";
import { WalletSignaturePreview } from "../components/wallet-signature-preview";

import { noop } from "./fixtures";

const meta: Meta = {
  title: "Special/Misc",
  decorators: [
    (Story) => (
      <div className="max-w-lg">
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj;

export const Checklist: Story = {
  render: () => (
    <div className="flex flex-col">
      <ChecklistRow status="pass" statusLabel="Passed" label="API key active" />
      <ChecklistRow status="pending" statusLabel="Checking" label="Balance check" />
      <ChecklistRow
        status="fail"
        statusLabel="Failed"
        label="Builder fee approved"
        detail="Approval is 0"
        fix={{ label: "Approve", href: "#" }}
      />
    </div>
  ),
};

export const Signature: Story = {
  render: () => (
    <WalletSignaturePreview
      title="You will sign"
      action="AddAPIKeyWithBuilder"
      fields={[
        { label: "name", value: "DRIFT" },
        { label: "maxFeeRate", value: "50", emphasis: true },
        { label: "expiresAt", value: "2027-04-26" },
      ]}
      note="Withdraw or transfer: never"
    />
  ),
};

export const States: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <EmptyState title="No bots yet" description="Create your first bot" />
      <ErrorState title="Could not load" retryLabel="Retry" onRetry={noop} />
    </div>
  ),
};
