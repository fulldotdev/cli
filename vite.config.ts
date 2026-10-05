import { defineConfig } from "vite-plus"

export default defineConfig({
  pack: {
    entry: ["src/cli.ts"],
    format: ["esm"],
    platform: "node",
    dts: false,
    clean: true,
  },
  lint: {
    plugins: ["oxc", "typescript", "unicorn", "import"],
    categories: { correctness: "error" },
    options: { typeAware: true, typeCheck: true },
    env: { builtin: true, es2024: true },
    ignorePatterns: ["dist/**"],
    rules: {
      "import/consistent-type-specifier-style": ["error", "prefer-top-level"],
      "import/no-duplicates": "error",
      "unicorn/prefer-node-protocol": "error",
      "typescript/consistent-type-imports": [
        "error",
        { prefer: "type-imports" },
      ],
      "typescript/no-unnecessary-condition": "error",
      "prefer-const": "error",
    },
  },
  fmt: {
    semi: false,
    printWidth: 80,
    sortPackageJson: false,
    ignorePatterns: ["dist", "node_modules", ".dev"],
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
})
