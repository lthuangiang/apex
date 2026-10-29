import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ImageResponse } from "next/og";

import messages from "../../messages/en.json";

// Ảnh Open Graph của Landing: dựng lại hero (eyebrow, hai dòng tiêu đề, mô tả) thay cho ảnh chụp, để luôn khớp
// câu chữ trong `messages/en.json` (UI_REVIEW K). Màu đọc từ token của theme sáng (`@drift/ui/tokens.css`), không
// viết mã màu ở đây.
export const alt = messages.landing.metaTitle;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

async function tokens(names: readonly string[]): Promise<Record<string, string>> {
  const css = await readFile(
    join(process.cwd(), "node_modules/@drift/ui/src/styles/tokens.css"),
    "utf8",
  );
  const root = css.slice(0, css.indexOf("}"));
  return Object.fromEntries(
    names.map((n) => [n, new RegExp(`--${n}:\\s*([^;]+);`).exec(root)?.[1]?.trim() ?? "black"]),
  );
}

export default async function OpengraphImage() {
  const h = messages.landing.hero;
  const c = await tokens(["bg", "ink", "ink-2", "accent"]);
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 24,
        padding: 80,
        background: c.bg,
        color: c.ink,
      }}
    >
      <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: 4, color: c.accent }}>
        {h.eyebrow}
      </div>
      <div style={{ display: "flex", flexDirection: "column", fontSize: 76, fontWeight: 800 }}>
        <span>{h.titleTop}</span>
        <span style={{ color: c.accent }}>{h.titleBottom}</span>
      </div>
      <div style={{ fontSize: 30, lineHeight: 1.4, maxWidth: 940, color: c["ink-2"] }}>
        {h.body}
      </div>
    </div>,
    size,
  );
}
