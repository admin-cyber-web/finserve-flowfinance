import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // The repository's other suites use bun:test; this runner covers the
    // security module only.
    include: ["tests/security.vitest.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: "forks",
    fileParallelism: false,
  },
});
