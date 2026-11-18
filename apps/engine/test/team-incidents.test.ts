import { teamOpsEventSchema } from "@drift/shared";
import { describe, expect, it } from "vitest";

import { redisEngineHealth, teamIncidentRow } from "../src/team-incidents";

// Báo team sự cố (#241): dòng outbox luôn qua được schema của jobs; bộ đếm sức khoẻ không bao giờ chờ hay ném.

describe("teamIncidentRow", () => {
  it("builds a jobs.team_ops row that the jobs schema accepts, cutting long text", () => {
    const row = teamIncidentRow({
      kind: "late_fill",
      botId: "0b5c1f9e-4a7d-4f00-9c3e-12ab34cd56ef",
      market: "M".repeat(60),
      detail: "x".repeat(500),
    });
    expect(row.topic).toBe("jobs.team_ops");
    const e = teamOpsEventSchema.parse(row.payload);
    expect(e).toMatchObject({ type: "team_incident", kind: "late_fill" });
    expect(JSON.stringify(row.payload)).not.toContain("x".repeat(201));
  });
});

describe("redisEngineHealth", () => {
  it("adds to the counter of the current minute with an expiry", async () => {
    const calls: unknown[][] = [];
    const count = redisEngineHealth(
      {
        multi: () => ({
          incrby: (k: string, n: number) => calls.push(["incrby", k, n]),
          pexpire: (k: string, ms: number) => calls.push(["pexpire", k, ms]),
          exec: () => Promise.resolve([]),
        }),
      },
      () => 120_000,
    );
    count("reads_skipped", 7);
    count("tick_slow");
    await Promise.resolve();
    expect(calls).toEqual([
      ["incrby", "team:engine_health:reads_skipped:2", 7],
      ["pexpire", "team:engine_health:reads_skipped:2", 7_200_000],
      ["incrby", "team:engine_health:tick_slow:2", 1],
      ["pexpire", "team:engine_health:tick_slow:2", 7_200_000],
    ]);
  });

  it("never throws or rejects when Redis fails", async () => {
    const throwing = redisEngineHealth({
      multi: () => {
        throw new Error("redis down");
      },
    });
    expect(() => {
      throwing("shard_lost");
    }).not.toThrow();
    const rejecting = redisEngineHealth({
      multi: () => ({
        incrby: () => undefined,
        pexpire: () => undefined,
        exec: () => Promise.reject(new Error("redis down")),
      }),
    });
    expect(() => {
      rejecting("shard_lost");
    }).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});
