import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { BottomSheet } from "../components/bottom-sheet";
import { ConfirmDialog } from "../components/confirm-dialog";
import { expectNoAxeViolations } from "../test/axe";

function StopHarness({
  pending = false,
  onConfirm = vi.fn(),
}: {
  pending?: boolean;
  onConfirm?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Stop…
      </button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Stop bot?"
        consequencesLabel="This will:"
        consequences={["Cancel 12 open orders", "Keep your position"]}
        confirmLabel="Stop bot"
        cancelLabel="Cancel"
        tone="danger"
        twoFactor={{ label: "2FA code", value: code, onChange: setCode }}
        pending={pending}
        pendingLabel="Stopping…"
        onConfirm={onConfirm}
      />
    </>
  );
}

describe("ConfirmDialog", () => {
  it("lists consequences and needs a 2FA code before confirming", async () => {
    const onConfirm = vi.fn();
    render(<StopHarness onConfirm={onConfirm} />);
    await userEvent.click(screen.getByRole("button", { name: "Stop…" }));

    const dialog = screen.getByRole("dialog", { name: "Stop bot?" });
    expect(dialog).toHaveTextContent("Cancel 12 open orders");
    const confirm = screen.getByRole("button", { name: "Stop bot" });
    expect(confirm).toBeDisabled();

    await userEvent.type(screen.getByLabelText("2FA code"), "123456");
    await userEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledOnce();
    await expectNoAxeViolations();
  });

  it("returns focus to the trigger when closed", async () => {
    render(<StopHarness />);
    const trigger = screen.getByRole("button", { name: "Stop…" });
    await userEvent.click(trigger);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(trigger).toHaveFocus();
    });
  });

  it("keeps the dialog open and locked while pending", async () => {
    render(<StopHarness pending />);
    await userEvent.click(screen.getByRole("button", { name: "Stop…" }));
    expect(screen.getByRole("button", { name: "Stopping…" })).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("BottomSheet", () => {
  it("renders an accessible dialog with title and footer", async () => {
    render(
      <BottomSheet
        open
        onOpenChange={() => undefined}
        title="Filters"
        footer={<button type="button">Apply</button>}
      >
        <p>Content</p>
      </BottomSheet>,
    );
    expect(screen.getByRole("dialog", { name: "Filters" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply" })).toBeInTheDocument();
    await expectNoAxeViolations();
  });
});
