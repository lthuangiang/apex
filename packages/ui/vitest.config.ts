import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    css: false,
    // a11y/ là test Playwright trên Storybook đã build (pnpm test:a11y).
    exclude: [...configDefaults.exclude, "a11y/**"],
  },
});
