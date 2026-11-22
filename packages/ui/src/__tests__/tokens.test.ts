// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("../styles/tokens.css", import.meta.url)), "utf8");

function token(name: string): string {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i").exec(css);
  if (!match?.[1]) throw new Error(`Missing color token --${name}`);
  return match[1];
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r = 0, g = 0, b = 0] = channels.map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

const WHITE = "#ffffff";

describe("design tokens", () => {
  it("defines every color token from docs/DESIGN.md section 13", () => {
    const expected = {
      bg: "#eef1fa",
      surface: "#ffffff",
      "surface-2": "#f5f7fd",
      border: "#e3e7f5",
      "border-input": "#d5dcf2",
      ink: "#141a33",
      "ink-2": "#3b4262",
      muted: "#5f6684",
      accent: "#2e62e8",
      "accent-ink": "#1d47b8",
      "accent-tint": "#e6ecfe",
      pos: "#0f7a43",
      "pos-bg": "#ddf4e7",
      "pos-dot": "#16a05a",
      "pos-border": "#a9dcbf",
      neg: "#c2312f",
      "neg-ink": "#a72826",
      "neg-bg": "#fde4e1",
      warn: "#7a3e00",
      "warn-bg": "#fdebd3",
      "warn-bar": "#e08a2e",
      unknown: "#5a2ca0",
      "unknown-bg": "#f0e6ff",
      "bot-orange": "#ffe3c7",
      "bot-teal": "#cdf1ec",
      "focus-ring": "#8fb0ff",
    };
    for (const [name, value] of Object.entries(expected)) {
      expect(token(name), name).toBe(value);
    }
  });

  it.each([
    ["ink", "bg"],
    ["ink-2", "surface"],
    ["ink-2", "surface-2"],
    ["muted", "surface"],
    ["muted", "surface-2"],
    ["muted", "bg"],
    ["accent-ink", "accent-tint"],
    ["accent-ink", "surface"],
    ["pos", "pos-bg"],
    ["neg-ink", "neg-bg"],
    ["warn", "warn-bg"],
    ["unknown", "unknown-bg"],
    // #413: chip / banner của dữ liệu version Rules cũ.
    ["old", "old-bg"],
  ])("keeps %s on %s at 4.5:1 or more", (fg, bg) => {
    expect(contrast(token(fg), token(bg))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(["accent", "neg", "ink"])("keeps white text on %s at 4.5:1 or more", (bg) => {
    expect(contrast(WHITE, token(bg))).toBeGreaterThanOrEqual(4.5);
  });

  // Market hours: ô có số dùng chữ ink trên các bậc xanh 0–2 (hàng "× day median"), mọi bậc cam (Cost per $1M) và mọi
  // bậc tím (Largest 1-min range / 15-min move).
  it.each([
    "mh-vol-0",
    "mh-vol-1",
    "mh-vol-2",
    "mh-cost-0",
    "mh-cost-1",
    "mh-cost-2",
    "mh-cost-3",
    "mh-shock-0",
    "mh-shock-1",
    "mh-shock-2",
    "mh-shock-3",
  ])("keeps ink text on %s at 4.5:1 or more", (bg) => {
    expect(contrast(token("ink"), token(bg))).toBeGreaterThanOrEqual(4.5);
  });

  // System Architecture Diagram: tên mạng viết bằng màu viền trên nền của chính mạng đó; số bước trắng trên ô xanh.
  it.each([
    ["arch-edge", "arch-edge-bg"],
    ["arch-core", "arch-core-bg"],
    ["arch-secure", "arch-secure-bg"],
    ["arch-ext", "arch-ext-bg"],
    ["arch-host", "surface"],
  ])("keeps %s labels on %s at 4.5:1 or more", (fg, bg) => {
    expect(contrast(token(fg), token(bg))).toBeGreaterThanOrEqual(4.5);
  });

  // Icon không thuộc luồng đang chọn: tên màu muted trên nền mạng (chữ, 4.5:1); icon viền màu nhóm trên nền trắng và
  // nền mạng (đồ hoạ, 3:1). Không làm mờ bằng opacity.
  it.each(["arch-edge-bg", "arch-core-bg", "arch-secure-bg", "arch-ext-bg"])(
    "keeps muted labels on %s at 4.5:1 or more",
    (bg) => {
      expect(contrast(token("muted"), token(bg))).toBeGreaterThanOrEqual(4.5);
    },
  );

  it.each(["arch-net", "arch-app", "arch-ml", "arch-db", "arch-int", "arch-sec", "arch-ext"])(
    "keeps %s icons at 3:1 or more on white and on every network background",
    (tone) => {
      for (const bg of ["surface", "arch-edge-bg", "arch-core-bg", "arch-secure-bg", "arch-ext-bg"])
        expect(contrast(token(tone), token(bg)), bg).toBeGreaterThanOrEqual(3);
      expect(contrast(WHITE, token(tone))).toBeGreaterThanOrEqual(3);
    },
  );

  it("keeps white step numbers on arch-badge at 4.5:1 or more", () => {
    expect(contrast(WHITE, token("arch-badge"))).toBeGreaterThanOrEqual(4.5);
  });
  // #454: tab Mainnet đang chọn của SegmentedControl (tone "pos") là chữ trắng trên `pos`; `pos-dot` không đủ (≈ 3.4:1).
  it("keeps white on pos at 4.5:1 or more", () => {
    expect(contrast(WHITE, token("pos"))).toBeGreaterThanOrEqual(4.5);
  });
});
