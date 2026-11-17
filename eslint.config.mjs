// @ts-check
import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import importPlugin from "eslint-plugin-import";
import jsxA11y from "eslint-plugin-jsx-a11y";
import globals from "globals";
import { config, configs as tsConfigs } from "typescript-eslint";

export default config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/storybook-static/**",
      "**/test-results/**",
      "**/playwright-report/**",
      // Next.js tự sinh lại file này ("should not be edited"); nó import `.next/types/*` chỉ có sau `next dev` /
      // `next build`, nên CI (chưa build) không resolve được. Không lint file sinh tự động.
      "apps/web/next-env.d.ts",
    ],
  },
  js.configs.recommended,
  ...tsConfigs.strictTypeChecked,
  ...tsConfigs.stylisticTypeChecked,
  importPlugin.flatConfigs.recommended,
  importPlugin.flatConfigs.typescript,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
      parserOptions: {
        projectService: { allowDefaultProject: ["*.mjs"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    settings: {
      "import/resolver": {
        typescript: {
          project: ["tsconfig.json", "{apps,packages}/*/tsconfig.json"],
          noWarnOnMultipleProjects: true,
        },
      },
    },
    rules: {
      // C2: dữ liệu ngoài đi qua zod, không ép kiểu; switch phải exhaustive.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/only-throw-error": "error",
      // C16: sắp xếp import, cấm import vòng.
      "import/no-cycle": "error",
      "import/order": [
        "error",
        {
          groups: ["builtin", "external", "internal", "parent", "sibling", "index"],
          "newlines-between": "always",
          alphabetize: { order: "asc", caseInsensitive: true },
        },
      ],
    },
  },
  {
    // Code trình duyệt: chunk tĩnh ai cũng tải được, nên không được kéo logic chiến lược, engine đề xuất hay package
    // chỉ chạy ở server vào bundle. Chỉ dùng `@drift/strategies/client` (schema, mặc định, hàm hiển thị thuần).
    files: ["apps/web/**/*.{ts,tsx}", "packages/ui/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@drift/strategies",
              message:
                "Browser code must import @drift/strategies/client: the root entry ships strategy step logic.",
            },
            {
              name: "@drift/shared",
              importNames: ["RECO_CONFIG", "recommend", "aiParameters", "paramsFor"],
              message:
                "Recommendation engine rules and thresholds stay on the server; use a dedicated constant (e.g. RECO_RECURRING).",
            },
          ],
          patterns: [
            {
              group: [
                "@drift/db",
                "@drift/db/*",
                "@drift/sodex",
                "@drift/sodex/*",
                "@drift/runtime",
                "@drift/runtime/*",
                "@drift/hyperliquid",
                "@drift/hyperliquid/*",
              ],
              message: "Server-only package; not allowed in browser code.",
            },
            {
              group: ["@drift/strategies/*", "!@drift/strategies/client"],
              message: "Browser code may only import @drift/strategies/client.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["**/*.tsx", "**/*.jsx"],
    ...jsxA11y.flatConfigs.strict,
  },
  {
    files: ["**/*.mjs", "**/*.js"],
    ...tsConfigs.disableTypeChecked,
  },
  prettier,
);
