import { describe, expect, it } from "vitest";

import { filtersFromSearch } from "../api";

// Link báo team (#241) mở SoDEX Debugger đã lọc sẵn theo bot / lỗi.

describe("filtersFromSearch", () => {
  it("reads a bot id and the show filter from the URL", () => {
    expect(filtersFromSearch("?botId=0B5C1F9E-4A7D-4F00-9C3E-12AB34CD56EF&show=errors")).toEqual({
      botId: "0b5c1f9e-4a7d-4f00-9c3e-12ab34cd56ef",
      show: "errors",
    });
  });

  it("ignores values that are not a bot id or a known filter", () => {
    expect(filtersFromSearch("?botId=abc&show=everything&call=1")).toEqual({});
    expect(filtersFromSearch("")).toEqual({});
  });
});
