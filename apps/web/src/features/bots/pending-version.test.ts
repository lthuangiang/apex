import type { BotDetail } from "@drift/shared";
import { describe, expect, it } from "vitest";

import { pendingVersionOf } from "./pending-version";

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
