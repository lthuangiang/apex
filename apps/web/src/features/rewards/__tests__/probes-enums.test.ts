import { describe, expect, it } from "vitest";

import { PROBES, distinctEnumValues, runProbe } from "../probes";

// Trang chẩn đoán: liệt kê giá trị khác nhau của status / pointsStatus / isLive trong week/list (chỉ enum, không số liệu;
// PM review 2026-11-26) để chốt hai loại tuần chưa chốt.

describe("distinctEnumValues", () => {
  it("lists distinct strings / booleans / null / missing, never numbers or address-like strings", () => {
    const rows = [
      { status: "LIVE", pointsStatus: "PENDING", isLive: true, points: 0 },
      { status: "COMPLETED", pointsStatus: "SNAPSHOT", isLive: false, points: 521 },
      { status: "COMPLETED", pointsStatus: "CONFIRMED", isLive: false, points: 3420 },
      { status: "0x3f2a000000000000000000000000000000009c4e", pointsStatus: null },
    ];
    expect(distinctEnumValues(rows, ["status", "pointsStatus", "isLive", "points"])).toEqual([
      { field: "status", values: ["COMPLETED", "LIVE"] },
      { field: "pointsStatus", values: ["CONFIRMED", "PENDING", "SNAPSHOT", "null"] },
      { field: "isLive", values: ["(missing)", "false", "true"] },
      // Số không bao giờ được liệt kê; chỉ ghi dòng thiếu trường.
      { field: "points", values: ["(missing)"] },
    ]);
    expect(distinctEnumValues({ not: "an array" }, ["status"])).toEqual([
      { field: "status", values: [] },
    ]);
  });

  it("the week/list probe reports the enum values", async () => {
    const spec = PROBES.find((p) => p.id === "sopoints/week/list");
    if (spec === undefined) throw new Error("no week/list probe");
    const data = [
      { weekNo: 13, weekName: "Week 13", status: "LIVE", isLive: true, pointsStatus: "PENDING" },
      {
        weekNo: 12,
        weekName: "Week 12",
        status: "COMPLETED",
        isLive: false,
        pointsStatus: "CONFIRMED",
      },
    ];
    const caller = (() => Promise.resolve(data)) as unknown as Parameters<typeof runProbe>[1];
    const r = await runProbe(spec, caller, caller);
    expect(r.enums).toEqual([
      { field: "status", values: ["COMPLETED", "LIVE"] },
      { field: "pointsStatus", values: ["CONFIRMED", "PENDING"] },
      { field: "isLive", values: ["false", "true"] },
    ]);
    const other = PROBES.find((p) => p.id === "sopoints/summary");
    if (other === undefined) throw new Error("no summary probe");
    expect((await runProbe(other, caller, caller)).enums).toBeNull();
  });
});
