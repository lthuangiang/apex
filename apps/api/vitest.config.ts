import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // Integration test dùng Testcontainers (CODING_STANDARDS C14).
    testTimeout: 30_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
