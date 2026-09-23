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
      // Files with nothing to execute or nothing worth executing. Each one
      // is here for a stated reason — this list is not a place to park a file
      // that is merely hard to test.
      exclude: [
        'tests/**',
        'build/**',
        'dist/**',
        '**/*.d.ts',
        '*.config.ts',
        // A flat emoji table generated from unicode.org's emoji-test.txt. Its
        // single statement is the array literal; "covering" it would assert
        // that a data file parses.
        'src/icon-battery.ts',
        // Pure type declarations and a re-export barrel: zero executable
        // statements, so v8 reports 0% forever no matter what the tests do.
        'src/ipc-contract.ts',
        'src/groups-model.ts',
        // The composition root. What remains after the split is the wiring
        // itself: building the Electron host, constructing the collaborators
        // and handing them to each other, plus `app.on('ready')` and the
        // signal handlers. Covering it means mocking electron, menubar,
        // electron-store and node:https to assert that wiring does not throw
        // — and the lifecycle handlers still never run under test, so it
        // could not reach the per-file bar anyway. The logic it used to hold
        // now lives in src/main/, which is covered.
        'src/main.ts',
      ],
      // A floor, not a ratchet: every file must carry its own weight, so a
      // new module cannot ride in on the average of the ones around it.
      //
      // Gated on statements and lines, which is what "70% covered" means to
      // a reader. Branches and functions are deliberately left ungated per
      // file: a module with one defensive `catch` that cannot be provoked, or
      // a small factory of one-line callbacks, fails a per-file branch gate
      // for reasons that say nothing about how well it is tested — and the
      // pressure to clear it is pressure to write assertions nobody needs.
      // They stay visible in the report, where a human can judge them.
      thresholds: {
        perFile: true,
        statements: 70,
        lines: 70,
      },
    },
  },
});
