import { defineConfig } from "vitest/config";

// Run from the repo root: `npx vitest run --config benchmark/vitest.config.ts`
export default defineConfig({
  test: {
    include: ["benchmark/tests/**/*.test.ts"],
  },
});
