import { defineConfig } from "vitest/config";

// Живі перевірки на справжній Google Таблиці (npm run test:live). У звичайний `npm test` не входять.
export default defineConfig({
  test: {
    include: ["test/live/**/*.live.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
