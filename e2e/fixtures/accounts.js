// Fixed staging fixture accounts for the annie-app E2E suite.
// These live on the real STAGING Supabase project (tqzafepeicfybxqysjjx),
// bootstrapped exactly like real signups. Re-runnable: nothing here is
// mutated destructively by the specs that use it (owner/admin only ever
// have new rows added under them, never deleted).
export const OWNER = {
  email: 'e2e-owner@meetannie-test.com',
  password: 'AnnieE2E!2026Test',
  teamId: '3956ca76-527d-4e6c-b112-cf5fa0227200',
}

export const NEWUSER = {
  email: 'e2e-newuser@meetannie-test.com',
  password: 'AnnieE2E!2026Test',
}

export const ADMIN = {
  email: 'e2e-admin@meetannie-test.com',
  password: 'AnnieE2E!2026Test',
}

// Stripe's own published test values — not a real card, safe to hardcode.
export const STRIPE_TEST_CARD = {
  number: '4242424242424242',
  expiry: '12/34',
  cvc: '123',
  name: 'E2E Test Cardholder',
  zip: '12345',
}

// Cached storageState files written by tests/global.setup.js, consumed by
// spec files via test.use({ storageState: OWNER_AUTH_FILE }).
export const OWNER_AUTH_FILE = 'e2e/.auth/owner.json'
export const ADMIN_AUTH_FILE = 'e2e/.auth/admin.json'

export function uniqueEmail(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}@meetannie-test.com`
}

// Every CRM record this suite creates gets this prefix so it's identifiable
// (and greppable) in the shared staging data afterward.
export const E2E_PREFIX = 'E2E-'
