import { describe, expect, it } from "vitest";

import { dec } from "../money";
import {
  H23_SAME_AS_CURRENT,
  h2Of,
  h3Of,
  midRankPercentile,
  SIGNAL_CONTEXT_RULES,
  SIGNAL_CONTEXT_V1,
  SIGNAL_CONTEXT_VERSION,
  type ContextFundingPoint,
} from "../signal-research/context";
import { TradeDirection } from "../signal-research/rules";

// Điều kiện gộp H2 / H3 giữa các context version (#353, review #365): "chỉ gộp khi hàm tính không đổi". "Does context help?"
// gộp H2 / H3 của mọi version trong `H23_SAME_AS_CURRENT`. Test này chốt hàm tính H2 / H3 đúng như lúc context-v1 ghi
// snapshot (ngưỡng + kết quả trên một bộ đầu vào cố định). Nếu test fail vì đổi `h2Of` / `h3Of` / ngưỡng: KHÔNG sửa số mong
// đợi ở đây cho khớp; hãy ra context version mới và bỏ version cũ khỏi `H23_SAME_AS_CURRENT` (H2 / H3 thôi gộp).

const T = Date.parse("2026-11-19T10:20:00Z");
const HOUR = 3_600_000;

/** n kỳ funding mỗi 8 giờ kết thúc trước T, kỳ cuối = `last`. */
const series = (n: number, last: string): ContextFundingPoint[] =>
  Array.from({ length: n }, (_, i) => ({
    at: T - (n - i) * 8 * HOUR,
    rate: i === n - 1 ? last : ((i % 10) * 0.00001).toFixed(6),
  }));

/** Kết quả H2 / H3 trên bộ đầu vào cố định, dạng so được. */
function fingerprint() {
  const h2 = (direction: TradeDirection, points: ContextFundingPoint[]) => {
    const r = h2Of({ direction, decidedAt: T, points });
    return [r.status, r.percentile, r.samples, r.payer, r.intervalHours, r.rate?.toFixed() ?? null];
  };
  const h3 = (direction: TradeDirection, moved: string | null, typical: string | null) => {
    const r = h3Of({
      direction,
      movedPct: moved === null ? null : dec(moved),
      typicalMovePct: typical === null ? null : dec(typical),
    });
    return [r.status, r.thresholdPct?.toFixed() ?? null];
  };
  return {
    h2: [
      h2(TradeDirection.long, series(90, "-0.0001")),
      h2(TradeDirection.short, series(90, "0.01")),
      h2(TradeDirection.long, series(90, "0.00005")),
      h2(TradeDirection.long, series(29, "-0.0001")),
      h2(TradeDirection.long, [...series(40, "0").map((p) => ({ ...p, at: p.at - 30 * HOUR }))]),
    ],
    h3: [
      h3(TradeDirection.long, "1", "1"),
      h3(TradeDirection.long, "0.99", "1"),
      h3(TradeDirection.short, "-1.2", "1"),
      h3(TradeDirection.short, "1.2", "1"),
      h3(TradeDirection.long, null, "1"),
      h3(TradeDirection.long, "1", "0"),
    ],
    midRank: [
      midRankPercentile("1", ["1", "1", "1", "1"]),
      midRankPercentile("0", ["0", "1", "2", "3"]),
    ],
  };
}

describe("H2 / H3 unchanged across merged context versions (#353)", () => {
  it("merges only context-v1 and the current version", () => {
    expect([...H23_SAME_AS_CURRENT].sort()).toEqual(
      [SIGNAL_CONTEXT_V1, SIGNAL_CONTEXT_VERSION].sort(),
    );
  });

  it("keeps the H2 / H3 thresholds that context-v1 recorded with", () => {
    const r = SIGNAL_CONTEXT_RULES;
    expect({
      h2LookbackDays: r.h2LookbackDays,
      h2LongMaxPercentile: r.h2LongMaxPercentile,
      h2ShortMinPercentile: r.h2ShortMinPercentile,
      h2MinSamples: r.h2MinSamples,
      h2MaxStaleHours: r.h2MaxStaleHours,
      h3Multiple: r.h3Multiple,
      h3TypicalHours: r.h3TypicalHours,
    }).toEqual({
      h2LookbackDays: 30,
      h2LongMaxPercentile: 20,
      h2ShortMinPercentile: 80,
      h2MinSamples: 30,
      h2MaxStaleHours: 24,
      h3Multiple: 1,
      h3TypicalHours: 1,
    });
  });

  it("computes H2 / H3 exactly as context-v1 did on a fixed set of inputs", () => {
    expect(fingerprint()).toEqual({
      h2: [
        ["yes", 0.5556, 90, "short", 8, "-0.0001"],
        ["yes", 99.4444, 90, "long", 8, "0.01"],
        ["no", 55.5556, 90, "long", 8, "0.00005"],
        ["na", null, 29, "short", 8, "-0.0001"],
        ["na", null, 40, "none", 8, "0"],
      ],
      h3: [
        ["yes", "1"],
        ["no", "1"],
        ["yes", "1"],
        ["no", "1"],
        ["na", "1"],
        ["na", "0"],
      ],
      midRank: [50, 12.5],
    });
  });
});
