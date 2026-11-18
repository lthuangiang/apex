import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";

import messages from "../../../../messages/en.json";
import { countNew } from "../live";

import { CANCEL, page, PLACE, SLOW } from "./fixtures";

const live = createTranslator({
  locale: "en",
  messages: { live: messages.sodexDebugger.live },
});
const t = (key: "newCalls" | "newCallsMore", values: { n: number }) => live(`live.${key}`, values);
const newer = (i: number) => ({
  ...PLACE,
  id: `0195f3a0-0000-7000-8000-0000000001${String(i).padStart(2, "0")}`,
  at: `2026-11-17T15:06:${String(i).padStart(2, "0")}.000Z`,
});

describe("Live new-call count", () => {
  it("uses the plural copy", () => {
    expect(t("newCalls", { n: 1 })).toBe("1 new call");
    expect(t("newCalls", { n: 3 })).toBe("3 new calls");
    expect(t("newCallsMore", { n: 50 })).toBe("50+ new calls");
  });

  it("counts calls newer than the shown list and flags when there may be more", () => {
    const shown = [CANCEL, PLACE, SLOW];
    expect(countNew(undefined, shown)).toBeNull();
    expect(countNew(page(shown), shown)).toBeNull();
    expect(countNew(page([newer(1), newer(2), CANCEL]), shown)).toEqual({ n: 2, more: false });
    expect(countNew(page([newer(2), newer(1)], "c1"), shown)).toEqual({ n: 2, more: true });
    expect(countNew(page([newer(2), newer(1)]), shown)).toEqual({ n: 2, more: false });
  });
});
