import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/generated/**", "apps/web/dev-dist/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": "error",
    },
  },
  {
    // Raw SQL is only allowed inside packages/db (ARCHITECTURE: tenancy and data protection).
    files: ["apps/**/*.ts", "apps/**/*.tsx", "packages/!(db)/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: [{ name: "pg", message: "Use repositories from @tappay/db; raw queries live only in packages/db." }] },
      ],
    },
  },
  {
    // CLI scripts may print.
    files: ["packages/db/src/cli/**/*.ts"],
    rules: { "no-console": "off" },
  },
);
