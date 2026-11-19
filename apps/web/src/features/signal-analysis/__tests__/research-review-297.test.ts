import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { ResearchArticleTrace, ResearchTraceStep } from "@drift/shared";
import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";

import messages from "../../../../messages/en.json";
import { tickPrice } from "../research/format";
import type { Tr } from "../research/text";
import { traceView } from "../research/trace-text";

import { ETH_TRACE } from "./news-trace-fixtures";

// Các điểm review UI của #297 có thể kiểm bằng hàm thuần: TP / SL theo tick, mức lúc vào lệnh khi câu chuyện có thêm
// nguồn; độ tương phản chữ trên tầng phễu sáng (#343).

// Kiểu namespace của next-intl suy từ messages toàn cục; ở đây chỉ cần hàm dịch như `useTranslations`.
const t = createTranslator({
  locale: "en",
  messages,
  namespace: "signalAnalysis.research" as never,
}) as unknown as Tr;

describe("tickPrice (#297): TP / SL rounded to the market tick on display", () => {
  it("rounds an old 18-decimal row to the tick and keeps the tick's digits", () => {
    expect(tickPrice("61412.992618091707312574", "0.1", "63566.5")).toBe("61,413.0");
    expect(tickPrice("64643.253690954146343713", "0.5", "63566.5")).toBe("64,643.5");
    expect(tickPrice("143.6", "0.01", "142.18")).toBe("143.60");
  });

  it("without the market list, uses the entry price's decimals (a SoDEX book price)", () => {
    expect(tickPrice("277.401007092434736281", null, "285.765")).toBe("277.401");
    expect(tickPrice("61412.992618091707312574", null, "63566.5")).toBe("61,413.0");
    expect(tickPrice("3467.10", null, null)).toBe("3,467.10");
  });
});

function withSteps(map: (s: ResearchTraceStep) => ResearchTraceStep): ResearchArticleTrace {
  return { ...ETH_TRACE, steps: ETH_TRACE.steps.map(map) };
}

describe("trace text (#297)", () => {
  it("level locked at entry but the story grew: 'Medium at entry · now 2 sources'", () => {
    const tr = withSteps((s) =>
      s.key === "normalize" && s.detail?.story != null
        ? { ...s, detail: { ...s.detail, story: { ...s.detail.story, sources: 2 } } }
        : s,
    );
    const score = traceView(tr, "UTC", t).steps[2];
    expect(score?.rows.find((r) => r.label === "Level")?.value).toBe(
      "Medium at entry · now 2 sources",
    );
    // Câu chuyện chưa có thêm nguồn: như cũ, kèm nguồn lúc vào.
    const same = traceView(ETH_TRACE, "UTC", t).steps[2];
    expect(same?.rows.find((r) => r.label === "Level")?.value).toBe("Medium: Reuters (top tier)");
  });

  it("Decide shows TP / SL at the market tick, never 18 decimals", () => {
    const tr = withSteps((s) =>
      s.key === "decide" && s.detail !== null
        ? {
            ...s,
            detail: {
              ...s.detail,
              tp: "3467.104618091707312574",
              sl: "3385.196996453782631859",
            },
          }
        : s,
    );
    const decide = traceView(tr, "UTC", t, (m) => (m === "ETH-USD" ? "0.01" : null)).steps[4];
    expect(decide?.rows.find((r) => r.label === "Take profit / Stop loss")?.value).toBe(
      "3,467.10 (+1.6%) / 3,385.20 (−0.8%)",
    );
  });
});

describe("funnel band contrast (#343): 4.5:1 on the light funnel", () => {
  const css = readFileSync(
    resolve(__dirname, "../../../../../../packages/ui/src/styles/tokens.css"),
    "utf8",
  );
  const token = (name: string): string => {
    const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
    if (m?.[1] === undefined) throw new Error(`token ${name}`);
    return m[1];
  };
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const [r = 0, g = 0, b = 0] = c.map((x) =>
      x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4,
    );
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
  };

  // color-mix(in srgb, a p%, b): trộn kênh tuyến tính trong sRGB như trình duyệt.
  const mix = (a: string, b: string, p: number): string => {
    const ch = (h: string, k: number) => parseInt(h.slice(1 + k * 2, 3 + k * 2), 16);
    const out = [0, 1, 2].map((k) => Math.round(ch(a, k) * p + ch(b, k) * (1 - p)));
    return `#${out.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  };

  it("every band's text is at least 4.5:1 on its fill (white on dark blues and green, ink on light blues)", () => {
    const white = "#ffffff";
    const pairs: [string, string][] = [
      [white, token("accent-ink")],
      [white, token("accent")],
      [token("ink"), mix(token("accent"), token("surface"), 0.6)],
      [token("ink"), token("surface")],
      [token("ink"), mix(token("accent"), token("surface"), 0.25)],
      [white, token("pos")],
      [token("muted"), token("bg")],
      [token("ink-2"), token("bg")],
    ];
    for (const [fg, bg] of pairs) expect(ratio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it("the H3 warning tag and the Yes badge keep 4.5:1 (amber on warn-bg, accent-ink on accent-tint)", () => {
    expect(ratio(token("warn"), token("warn-bg"))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(token("accent-ink"), token("accent-tint"))).toBeGreaterThanOrEqual(4.5);
  });

  it("context effects run only through motion-safe and the swimming whales hide on reduced motion", () => {
    const src = readFileSync(resolve(__dirname, "../research/context-panel.tsx"), "utf8");
    expect(src).not.toMatch(/(^|[\s"`])animate-\[/);
    expect(src).toContain("motion-reduce:hidden motion-safe:animate-[sr-swim_2.6s");
    const globals = readFileSync(resolve(__dirname, "../../../app/globals.css"), "utf8");
    for (const k of ["sr-whale", "sr-sonar", "sr-tip", "sr-wobble", "sr-run", "sr-pop", "sr-swim"])
      expect(globals).toContain(`@keyframes ${k} `);
  });
});
