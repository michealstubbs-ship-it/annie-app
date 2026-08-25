import { test, expect } from '@playwright/test'
import { OWNER } from '../fixtures/accounts.js'
import { loginAndReachDashboard } from '../fixtures/auth.js'

// Scenario 3: e2e-owner is fully onboarded (onboarding_completed=true,
// linkedin_import_completed=true), so logging in should land directly on
// the dashboard overview, not onboarding or the LinkedIn import step.
// Deliberately logs in fresh here (not via the cached storageState) so the
// actual post-login redirect behaviour itself is under test.
test.describe('Existing onboarded user login', () => {
  test('e2e-owner lands on the dashboard overview with full Sidebar nav', async ({ page }) => {
    await test.step('log in', async () => {
      await page.goto('/login')
      await page.locator('#login-email').fill(OWNER.email)
      await page.locator('#login-password').fill(OWNER.password)
      await page.getByRole('button', { name: 'Sign in' }).click()
    })

    await test.step('lands on /dashboard, not /onboarding or /import', async () => {
      await page.waitForURL(url => !url.pathname.startsWith('/login'), { timeout: 20000 })
      await expect(page).toHaveURL(/\/dashboard$/)
    })

    await test.step('Sidebar renders every expected nav section', async () => {
      const nav = page.locator('nav')
      for (const label of [
        'Overview', "Today's Actions", 'Intelligence Feed', 'Contacts', 'Companies',
        'BD Pipeline', 'Meetings', 'Tasks', 'Ask Annie', 'Jobs & Mandates', 'Candidates',
        'Billing', 'Settings',
      ]) {
        await expect(nav.getByText(label, { exact: true })).toBeVisible()
      }
      // Owner fixture is not an admin — Insights must not appear in nav.
      await expect(nav.getByText('Insights', { exact: true })).toHaveCount(0)
    })

    await test.step('owner profile identity shows in the Sidebar footer', async () => {
      await expect(page.getByText('E2E Test Firm')).toBeVisible()
    })
  })
})
