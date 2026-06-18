import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "packages/**/*.test.ts"],
    exclude: ["dist/**", "**/node_modules/**", "packages/**/dist/**"],
    // Bound the worker pool so a cockpit test run can't balloon RAM. By default
    // vitest forks ~one worker per core (12 on this machine, ~80–100 MB each ≈
    // 1 GB/run). When several project captains (e.g. the oneplan captain) run
    // their own vitest concurrently on the same machine, those uncapped pools
    // stack and exhaust RAM. Capping cockpit to 2 forks keeps its footprint
    // ~200 MB while the suite is small/fast (~3s). teardownTimeout guards
    // against a hung worker wedging shutdown.
    pool: "forks",
    poolOptions: { forks: { minForks: 1, maxForks: 2 } },
    teardownTimeout: 10_000,
  },
});
