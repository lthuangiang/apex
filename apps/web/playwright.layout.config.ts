import { defineConfig } from "@playwright/test";

// Test bố cục cần layout thật (trình duyệt), chạy trên bản build của web với API giả (page.route): `pnpm build` rồi
// `pnpm test:layout`. Không cần Docker hay backend.
const PORT = Number(process.env.LAYOUT_PORT ?? 3347);
// #457: LAYOUT_BROWSER=webkit chạy cùng bộ test trên WebKit của Playwright (ảnh Safari); mặc định Chromium.
const BROWSER = process.env.LAYOUT_BROWSER === "webkit" ? "webkit" : "chromium";

export default defineConfig({
  testDir: "./layout-tests",
  testMatch: "*.layout.ts",
  fullyParallel: true,
  reporter: "list",
  timeout: 60_000,
  use: {
    baseURL: `http://127.0.0.1:${String(PORT)}`,
    reducedMotion: "reduce",
    browserName: BROWSER,
  },
  webServer: {
    command: `pnpm exec next start -p ${String(PORT)}`,
    url: `http://127.0.0.1:${String(PORT)}/login`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [1024, 1280, 1440].map((width) => ({
    name: `w${String(width)}`,
    use: { viewport: { width, height: 1000 } },
  })),
});
