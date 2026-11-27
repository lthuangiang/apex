// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it } from "vitest";

import { BOX_SIMPLE_BELOW, BoxArt, boxKindOf } from "../components/box-art";
import { fromTrading, levelDotClass, rewardRange } from "../format";

// Bộ hình box (#575, DEC-400): chọn hình theo cấp, bản giản lược dưới 56 px, bản mờ, tên cho trình đọc màn hình; màu chỉ
// từ token. Khoảng thưởng / "From trading" theo lottery/meta.

afterEach(() => {
  cleanup();
});

describe("boxKindOf", () => {
  it("maps SoDEX level names (any case / spacing) and falls back to Mystery", () => {
    expect(boxKindOf("Common")).toBe("common");
    expect(boxKindOf("uncommon")).toBe("uncommon");
    expect(boxKindOf("RARE")).toBe("rare");
    expect(boxKindOf("Super Rare")).toBe("superrare");
    expect(boxKindOf("SuperRare")).toBe("superrare");
    expect(boxKindOf("Mythic")).toBe("mystery");
    expect(boxKindOf(null)).toBe("mystery");
  });
});

describe("BoxArt", () => {
  it("draws each level at every size; small sizes drop details; colours come from tokens only", () => {
    for (const level of ["Common", "Uncommon", "Rare", "SuperRare", null]) {
      for (const size of [160, 64, 28]) {
        const { container } = render(<BoxArt level={level} size={size} />);
        const svg = container.querySelector("svg");
        if (svg === null) throw new Error("no svg");
        expect(svg).toHaveAttribute("width", String(size));
        expect(svg).toHaveAttribute("data-kind", boxKindOf(level));
        expect(svg).toHaveAttribute("aria-hidden", "true");
        const small = size < BOX_SIMPLE_BELOW;
        expect(svg.getAttribute("data-simple")).toBe(small ? "true" : null);
        // Nắp tách nhóm (popup bật nắp).
        expect(svg.querySelector(".bx-lid")).not.toBeNull();
        if (small) {
          expect(svg.querySelector(".bx-shine")).toBeNull();
          expect(svg.querySelector(".bx-spark")).toBeNull();
          expect(svg.querySelector("ellipse")).toBeNull();
        }
        expect(svg.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,6}\b(?!-)/);
        cleanup();
      }
    }
  });

  it("Rare / SuperRare shine and SuperRare sparkles only at full size; Mystery shows '?'", () => {
    const rare = render(<BoxArt level="Rare" size={110} />).container;
    expect(rare.querySelector(".bx-shine")).not.toBeNull();
    expect(rare.querySelector(".bx-spark")).toBeNull();
    cleanup();
    const sr = render(<BoxArt level="SuperRare" size={110} />).container;
    expect(sr.querySelectorAll(".bx-spark")).toHaveLength(3);
    cleanup();
    const m = render(<BoxArt level={null} size={64} />).container;
    expect(m.querySelector("text")?.textContent).toBe("?");
  });

  it("faded and labelled variants; shine gradients get unique ids per box", async () => {
    const { container } = render(
      <div>
        <BoxArt level="Rare" size={110} faded label="Rare" />
        <BoxArt level="Rare" size={110} />
      </div>,
    );
    const img = screen.getByRole("img", { name: "Rare" });
    expect(img.getAttribute("style")).toContain("opacity: 0.38");
    const ids = [...container.querySelectorAll("linearGradient")].map((g) => g.id);
    expect(new Set(ids).size).toBe(2);
    expect((await axe.run(container)).violations).toEqual([]);
  });
});

describe("level colour, reward range, From trading", () => {
  it("level dots use the new tokens (Common is cream, not grey)", () => {
    expect(levelDotClass("Common")).toBe("bg-lvl-common");
    expect(levelDotClass("SuperRare")).toBe("bg-lvl-superrare");
    expect(levelDotClass("Mythic")).toBe("bg-border-input");
  });

  it("reward range from rules.rewardBands; no band or bad numbers → nothing", () => {
    const bands = [
      { level: "Common", minUsd: 1, maxUsd: 8 },
      { level: "Rare", minUsd: "103", maxUsd: "1325" },
      { level: "Uncommon", minUsd: null, maxUsd: 215 },
    ];
    expect(rewardRange(bands, "Common")).toBe("$1.00 – $8.00");
    expect(rewardRange(bands, "rare")).toBe("$103.00 – $1,325.00");
    expect(rewardRange(bands, "Uncommon")).toBeNull();
    expect(rewardRange(bands, "SuperRare")).toBeNull();
    expect(rewardRange(null, "Common")).toBeNull();
  });

  it("From trading only for rules.tradeBoxLevels", () => {
    expect(fromTrading(["Common", "Uncommon"], "common")).toBe(true);
    expect(fromTrading(["Common", "Uncommon"], "Rare")).toBe(false);
    expect(fromTrading(null, "Common")).toBe(false);
  });
});
