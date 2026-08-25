import { test, expect } from '@playwright/test'
import { OWNER_AUTH_FILE, ADMIN_AUTH_FILE } from '../fixtures/accounts.js'

// Scenario 12: access control around /dashboard/insights (Admin Overview),
// enforced by Dashboard.jsx's AdminRoute wrapper (profile.is_admin gate).
test.describe('Admin Overview — access control', () => {
  test.describe('as a non-admin (owner)', () => {
    test.use({ storageState: OWNER_AUTH_FILE })

    test('Insights is not in the Sidebar nav, and the route redirects away', async ({ page }) => {
      await page.goto('/dashboard')
      await expect(page.locator('nav').getByText('Insights', { exact: true })).toHaveCount(0)

      await page.goto('/dashboard/insights')
      // AdminRoute redirects a non-admin straight back to /dashboard.
      await expect(page).toHaveURL(/\/dashboard$/, { timeout: 15000 })
      await expect(page.getByText('Operator dashboard')).toHaveCount(0)
    })
  })

  test.describe('as an admin', () => {
    test.use({ storageState: ADMIN_AUTH_FILE })

    test('Admin Overview renders real content: MRR, signups, funnel, at-risk accounts', async ({ page }) => {
      await page.goto('/dashboard/insights')
      await expect(page).toHaveURL(/\/dashboard\/insights/)
      await expect(page.getByRole('heading', { name: 'Operator dashboard' })).toBeVisible({ timeout: 20000 })

      await expect(page.getByText('MRR', { exact: true })).toBeVisible()
      await expect(page.getByText('Active accounts')).toBeVisible()
      await expect(page.getByText('New signups')).toBeVisible()
      await expect(page.getByText('Signup funnel')).toBeVisible()
      await expect(page.getByText('At-risk accounts')).toBeVisible()
    })
  })
})
