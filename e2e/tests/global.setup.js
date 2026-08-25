import { test as setup } from '@playwright/test'
import { OWNER, ADMIN, OWNER_AUTH_FILE, ADMIN_AUTH_FILE } from '../fixtures/accounts.js'
import { loginAndReachDashboard } from '../fixtures/auth.js'

// Logs in once per already-onboarded fixture account and caches the
// resulting storageState, so every other spec that needs to act "as the
// owner" or "as the admin" can skip repeating the login round-trip.
// Scenarios that need a FRESH state (new signup, or e2e-newuser walking
// through onboarding for the first time) log in directly instead — see
// their own spec files.
setup('authenticate as owner', async ({ page }) => {
  await loginAndReachDashboard(page, OWNER.email, OWNER.password)
  await page.context().storageState({ path: OWNER_AUTH_FILE })
})

setup('authenticate as admin', async ({ page }) => {
  await loginAndReachDashboard(page, ADMIN.email, ADMIN.password)
  await page.context().storageState({ path: ADMIN_AUTH_FILE })
})
