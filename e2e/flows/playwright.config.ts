import { defineConfig } from "@playwright/test";

// E2E P3 (CODING_STANDARDS C14, mục 14): đăng ký → kết nối hai chữ ký → Settings → revoke → approve lại.
export default defineConfig({
  testDir: "./tests",
  globalSetup: "./global-setup.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:13100", trace: "retain-on-failure" },
  projects: [
    { name: "desktop-1440", use: { viewport: { width: 1440, height: 900 } } },
    { name: "mobile-390", use: { viewport: { width: 390, height: 844 } } },
  ],
});
