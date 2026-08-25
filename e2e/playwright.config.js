import { defineConfig, devices } from '@playwright/test'

// E2E suite against the live test-payments branch deploy (real Netlify +
// real staging Supabase + real Stripe test mode — see README note in
// fixtures/accounts.js). Everything here hits the real network, so
// timeouts are generous rather than the tight defaults appropriate for a
// local dev server.
//
// This container's Chromium needs two non-obvious launch flags to reach
// the public internet at all: the ambient HTTPS_PROXY env vars this
// session sets get auto-detected by Chromium's Linux proxy config lookup,
// which routes traffic into a TLS-terminating proxy Chromium doesn't trust
// (unlike curl, which trusts it via the system CA store) — `--no-proxy-server`
// + `--proxy-bypass-list=*` force a direct connection, and
// `--ignore-certificate-errors` covers any interception still in the path.
// Confirmed necessary by direct reproduction: without them every
// navigation fails with net::ERR_CONNECTION_RESET / ERR_CERT_AUTHORITY_INVALID.
const LAUNCH_ARGS = ['--no-sandbox', '--no-proxy-server', '--proxy-bypass-list=*', '--ignore-certificate-errors']

export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false, // shared staging data + Stripe checkout flows are safer run serially
  retries: 0,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: './report' }],
  ],
  outputDir: './test-results',
  use: {
    baseURL: 'https://test-payments--annie-app.netlify.app',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    ignoreHTTPSErrors: true,
    launchOptions: { executablePath: '/opt/pw-browsers/chromium', args: LAUNCH_ARGS },
  },
  projects: [
    {
      name: 'setup',
      testMatch: /global\.setup\.js/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
    },
  ],
})
