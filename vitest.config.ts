import { defineConfig } from "vitest/config";

// tests/e2e/real-* start real Codex ACP / Antigravity processes and call real
// (billed) models with the user's own accounts. They are excluded by default;
// opt in explicitly with AGENTHUB_REAL_TESTS=1 (see `npm run test:real`).
const realTests = process.env.AGENTHUB_REAL_TESTS === "1";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["logs/**", "node_modules/**", "dist/**", ...(realTests ? [] : ["tests/e2e/real-*"])],
  },
});
