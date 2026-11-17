import type { BotDetail } from "@drift/shared";
import { describe, expect, it } from "vitest";

import { pendingNoteOf, pendingVersionOf } from "./pending-version";

const v = (version: number, status: BotDetail["versions"][number]["status"]) =>
  ({
    id: `00000000-0000-7000-8000-00000000000${String(version)}`,
    version,
    config: { v: version },
    paramSource: "manual",
    status,
    createdAt: "2026-11-17T08:00:00.000Z",
    appliedAt: null,
  }) as const;

describe("pendingVersionOf (DEC-TBD-vf-version-apply)", () => {
  it("returns the newest pending version above the active one", () => {
    expect(
      pendingVersionOf([v(1, "superseded"), v(2, "active"), v(3, "pending"), v(4, "pending")])
        ?.version,
    ).toBe(4);
  });

  it("ignores stale pending rows at or below the active version, and no pending at all", () => {
    expect(pendingVersionOf([v(2, "pending"), v(3, "active")])).toBeUndefined();
    expect(pendingVersionOf([v(1, "active")])).toBeUndefined();
  });
});

describe("pendingNoteOf (DEC-TBD-vf-version-apply)", () => {
  it("explains a waiting Volume Farm version, running or paused", () => {
    expect(pendingNoteOf("volume_farm", "running")).toBe("waitingFarm");
    expect(pendingNoteOf("volume_farm", "paused")).toBe("waitingFarmPaused");
  });

  it("explains a waiting version of any other strategy only while paused (applies on resume)", () => {
    expect(pendingNoteOf("spot_grid", "paused")).toBe("waitingPaused");
    expect(pendingNoteOf("futures_dca", "running")).toBeNull();
  });
});
