import { configDefaults, defineConfig } from "vitest/config";

// Unit test không gọi mạng (CODING_STANDARDS C14). Smoke test mainnet nằm ở smoke/ và chỉ
// chạy khi có SODEX_SMOKE=1.
const smoke = process.env.SODEX_SMOKE === "1";

export default defineConfig({
  test: {
    include: smoke ? ["smoke/**/*.smoke.test.ts"] : ["src/**/*.test.ts"],
    exclude: [...configDefaults.exclude],
    testTimeout: smoke ? 20_000 : 5_000,
  },
});
