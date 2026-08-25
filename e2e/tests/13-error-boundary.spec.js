import { test } from '@playwright/test'

// Scenario 13: ErrorBoundary (src/components/ErrorBoundary.jsx) only ever
// catches a genuine React render-time throw. Searched the whole app for a
// deliberate test hook (a debug route, a ?throw= query flag, a
// window.__test escape hatch) and found none — grep for
// __test|forceError|debugError|simulateError across src/ and netlify/
// turned up nothing, and every dashboard sub-route in Dashboard.jsx is a
// real, working page; there's no route that reliably throws during render.
//
// The one known real-world trigger (a stale chunk-hash reference after a
// new deploy — see the boundary's own 2026-08-24 comment) can't be
// reproduced on demand either: it requires this exact tab to have been
// open across an actual new Netlify deploy of this branch, which isn't
// something a test run can cause or time.
//
// Forcing this artificially (e.g. injecting a throw via page.evaluate())
// would test Playwright's own error-injection, not the app's real
// boundary, so per the task's own instruction this scenario is skipped
// rather than faked.
test.skip('ErrorBoundary — no reachable live trigger exists in this app; skipped rather than forced', () => {})
