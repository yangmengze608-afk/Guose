import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Examples are static target input, not Guose code or installed React applications.
  { ignores: ["dist/**", "coverage/**", "examples/**", "tests/fixtures/transformation-project/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["scripts/*.mjs"],
    // Runtime scripts consume dist; first-checkout lint must not require a build.
    // Keep ordinary JS lint; product TypeScript retains type-aware rules.
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { globals: { process: "readonly" } },
  },
);
