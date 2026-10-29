import { BotState, ReasonCode } from "@drift/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ComingSoonChip } from "../components/coming-soon-chip";
import { ConnectionStatus } from "../components/connection-status";
import { LastUpdated } from "../components/last-updated";
import { LiveBadge } from "../components/live-badge";
import { StaleBadge } from "../components/stale-badge";
import { StatusPill } from "../components/status-pill";
import { expectNoAxeViolations } from "../test/axe";

const at = { dateTime: "2026-10-26T14:02:09Z", text: "Oct 26, 2:02 PM" };

describe("badges", () => {
  it("renders the LIVE badge with its label", async () => {
    render(<LiveBadge label="LIVE · MAINNET" />);
    expect(screen.getByText("LIVE · MAINNET")).toBeInTheDocument();
    await expectNoAxeViolations();
  });

  it("shows the disabled reason on the coming soon chip", async () => {
    render(<ComingSoonChip label="Paper · Coming soon" />);
    expect(screen.getByText("Paper · Coming soon")).toHaveAttribute("aria-disabled", "true");
    await expectNoAxeViolations();
  });

  it.each(["connected", "connecting", "disconnected"] as const)(
    "announces the %s connection state as text",
    async (state) => {
      render(<ConnectionStatus state={state} label={`label-${state}`} />);
      expect(screen.getByRole("status")).toHaveTextContent(`label-${state}`);
      await expectNoAxeViolations();
    },
  );

  it("renders last updated and stale times as <time>", async () => {
    const { container } = render(
      <>
        <LastUpdated label="Updated" at={at} />
        <StaleBadge label="Stale" updatedAt={at} />
      </>,
    );
    const times = container.querySelectorAll("time");
    expect(times).toHaveLength(2);
    expect(times[0]).toHaveAttribute("dateTime", at.dateTime);
    await expectNoAxeViolations();
  });

  it("marks transitional bot states as busy until the backend confirms", async () => {
    render(<StatusPill state={BotState.pausing} label="Pausing…" />);
    expect(screen.getByText("Pausing…").closest("[data-state]")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    await expectNoAxeViolations();
  });

  it("shows the reason code label next to a paused state", async () => {
    render(
      <StatusPill
        state={BotState.paused}
        label="Paused"
        reason={ReasonCode.builderFeeRevoked}
        reasonLabel="Builder fee revoked"
      />,
    );
    expect(screen.getByText("Builder fee revoked")).toHaveAttribute(
      "data-reason",
      "BUILDER_FEE_REVOKED",
    );
    expect(screen.getByText("Paused").closest("[data-state]")).not.toHaveAttribute("aria-busy");
    await expectNoAxeViolations();
  });

  it("shows needs attention as text, not only color", () => {
    render(
      <StatusPill
        state={BotState.running}
        label="Running"
        needsAttention
        needsAttentionLabel="Out of range"
      />,
    );
    expect(screen.getByText("Out of range")).toBeInTheDocument();
  });
});
