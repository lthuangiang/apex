import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

import { BottomSheet } from "../components/bottom-sheet";
import { Button } from "../components/button";
import { ConfirmDialog } from "../components/confirm-dialog";

const meta: Meta = { title: "Overlay/Dialogs" };
export default meta;
type Story = StoryObj;

function StopDialog({ pending = false, error }: { pending?: boolean; error?: string }) {
  const [open, setOpen] = useState(true);
  const [code, setCode] = useState(pending ? "123456" : "");
  return (
    <>
      <Button
        variant="danger"
        onClick={() => {
          setOpen(true);
        }}
      >
        Stop…
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Stop bot?"
        consequencesLabel="This will:"
        consequences={["Cancel 12 open orders", "Keep your current position"]}
        confirmLabel="Stop bot"
        cancelLabel="Cancel"
        tone="danger"
        twoFactor={{
          label: "2FA code",
          value: code,
          onChange: setCode,
          ...(error ? { error } : {}),
        }}
        pending={pending}
        pendingLabel="Stopping…"
        onConfirm={() => undefined}
      />
    </>
  );
}

export const Confirm: Story = { render: () => <StopDialog /> };
export const ConfirmError: Story = { render: () => <StopDialog error="Code is incorrect" /> };
export const ConfirmPending: Story = { render: () => <StopDialog pending /> };

function SheetDemo() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <Button
        onClick={() => {
          setOpen(true);
        }}
      >
        Open sheet
      </Button>
      <BottomSheet
        open={open}
        onOpenChange={setOpen}
        title="Filters"
        footer={
          <Button
            onClick={() => {
              setOpen(false);
            }}
          >
            Apply
          </Button>
        }
      >
        <p className="text-sm text-ink-2">Sheet content</p>
      </BottomSheet>
    </>
  );
}

export const Sheet: Story = {
  render: () => <SheetDemo />,
  globals: { viewport: { value: "mobile" } },
};
