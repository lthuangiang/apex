import { defineConfig } from "@playwright/test";

const PORT = 6007;

// Chạy axe trên trình duyệt thật cho mọi story đã build (gồm cả color-contrast).
export default defineConfig({
  testDir: "./a11y",
  fullyParallel: true,
  reporter: "list",
  use: { baseURL: `http://127.0.0.1:${String(PORT)}` },
  projects: [
    { name: "desktop-1440", use: { viewport: { width: 1440, height: 900 } } },
    { name: "mobile-390", use: { viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: `vite preview --outDir storybook-static --host 127.0.0.1 --port ${String(PORT)} --strictPort`,
    url: `http://127.0.0.1:${String(PORT)}/index.json`,
    reuseExistingServer: false,
  },
});
