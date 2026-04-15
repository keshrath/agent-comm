// =============================================================================
// Vitest config for the Tier A unit bench.
//
// Uses regular `describe` / `it` (not the bench() API) so each primitive can
// assert against its target — that's the CI gate. The .bench.ts suffix is
// kept because the file's PURPOSE is benchmarking, even though we drive it
// through `vitest run` rather than `vitest bench`.
//
// Long testTimeout because the SQLite throughput bench writes 5k rows on
// older laptops, and the fail-open bench can wait on a 1.5s HTTP timeout.
// =============================================================================

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['bench/unit/**/*.bench.ts'],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    // Run benches serially to keep p50/p95 stable. Parallel forks compete for
    // CPU and inflate variance well past the 10% determinism budget.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
  },
});
