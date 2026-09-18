import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    reporters: ['tree', 'hanging-process'],
    slowTestThreshold: 300,
    // The whole suite runs in ~7s and the slowest test that relies on this
    // generic budget takes ~3.8s locally (it spawns a real CLI). 15s leaves
    // room for a CI runner several times slower than a dev laptop while still
    // failing a genuine hang fast: the two CLI tests that need more already
    // pass their own timeout as the third argument to `it`.
    testTimeout: 15_000,
    // Same budget for hooks: the slowest setup here builds throwaway git
    // repositories and temp directories, which is the same order of cost as
    // the slowest test.
    hookTimeout: 15_000,
    coverage: {
      // v8 is the runtime's own coverage, so it needs no instrumentation pass
      // and does not slow the suite down.
      provider: 'v8',
      // 'text' prints the table in the terminal, 'lcov' feeds external tools
      // (it also emits the HTML report), and 'json-summary' keeps the totals
      // machine-readable.
      reporter: ['text', 'lcov', 'json-summary'],
      // Only real product code counts.
      include: ['src/**/*.ts', 'renderer/**/*.ts', 'scripts/**/*.ts'],
      // Tests, build output, type-only declarations and tooling config are not
      // product code and would dilute the numbers either way.
      exclude: ['tests/**', 'build/**', 'dist/**', '**/*.d.ts', '*.config.ts'],
      // A ratchet, not a target: these sit just under the numbers the suite
      // actually produces today (21.8 / 26.34 / 22.77 / 21.39), so coverage
      // can only be raised from here, never quietly dropped. The absolute
      // values are low because the never-imported entry points (src/main.ts,
      // renderer/logs.ts, renderer/config.ts, renderer/tray.ts) are ~10k
      // uncovered lines of the total and stay in scope on purpose.
      thresholds: {
        statements: 21,
        branches: 26,
        functions: 22,
        lines: 21,
      },
    },
  },
});
