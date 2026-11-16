import { describe, expect, it } from "vitest";

import {
  hhmm,
  markersFor,
  offsetLabel,
  offsetMinutes,
  usOpenUtcMinutes,
} from "../market-hours-time";

// Market hours: giờ địa phương theo Intl, kể cả múi giờ lệch nửa giờ và ngày Mỹ đổi giờ.

describe("market hours time", () => {
  it("reads the offset of whole-hour and half-hour zones", () => {
    const at = new Date("2026-11-16T12:00:00Z");
    expect(offsetMinutes("Asia/Ho_Chi_Minh", at)).toBe(420);
    expect(offsetMinutes("Asia/Kolkata", at)).toBe(330);
    expect(offsetMinutes("Europe/London", at)).toBe(0);
    expect(offsetMinutes("UTC", at)).toBe(0);
    expect(offsetLabel(420)).toBe("UTC+7");
    expect(offsetLabel(330)).toBe("UTC+5:30");
    expect(offsetLabel(-300)).toBe("UTC−5");
    expect(offsetLabel(0)).toBe("UTC+0");
  });

  it("puts US stock open at 13:30 UTC in summer time and 14:30 UTC in winter", () => {
    expect(usOpenUtcMinutes(new Date("2026-10-30T12:00:00Z"))).toBe(13 * 60 + 30);
    expect(usOpenUtcMinutes(new Date("2026-11-16T12:00:00Z"))).toBe(14 * 60 + 30);
  });

  it("shows the markers in the viewer's local hours", () => {
    const at = new Date("2026-11-16T12:00:00Z");
    const vn = markersFor(420, at);
    expect(vn.map((m) => `${hhmm(m.local)}·${hhmm(m.utc)}${m.us ? "·US" : ""}`)).toEqual([
      "07:00·00:00",
      "09:00·02:00",
      "15:00·08:00",
      "16:00·09:00",
      "21:30·14:30·US",
      "23:00·16:00",
    ]);
    // Kolkata (+5:30): mốc ở phút :30 nằm trong cột giờ địa phương đó.
    const ind = markersFor(330, at);
    expect(ind[0]).toMatchObject({ local: 5 * 60 + 30, hour: 5 });
    expect(ind.find((m) => m.us)).toMatchObject({ local: 20 * 60, hour: 20 });
  });
});
