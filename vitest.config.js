import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.js', 'netlify/**/*.test.js'],
    // 2026-08-31: several suites (start-trial-checkout.test.js is the
    // worst) call vi.resetModules() and then re-import the whole handler
    // inside beforeEach, which re-transforms its entire module graph —
    // including scanShared.js, which is ~160KB — once per test. On a fast
    // disk that is ~120ms and invisible. On this repo's actual home, a
    // OneDrive-synced folder, the same import step measured 52 SECONDS
    // across the suite, and the 10s default hookTimeout started failing
    // the first test in that file while all 838 others passed. That is a
    // machine-speed problem, not a broken test: the identical file passes
    // 14/14 in 1.3s off OneDrive. Raised rather than papered over with a
    // skip, and deliberately generous so a slow sync day doesn't produce
    // a red suite that sends someone hunting for a bug that isn't there.
    hookTimeout: 60000,
    testTimeout: 30000,
  },
})
