import { test, expect } from '@playwright/test'
import { OWNER_AUTH_FILE } from '../fixtures/accounts.js'

test.use({ storageState: OWNER_AUTH_FILE })

// Scenario 9: e2e-owner has an active Team-tier subscription, 3 seats.
// Read-mostly per the task — we assert "Manage billing" is present and
// enabled, but deliberately do NOT click it through to a real Stripe
// portal session.
test.describe('Billing — active plan', () => {
  test('shows the active Team plan, 3 seats, and a Manage billing control', async ({ page }) => {
    await page.goto('/dashboard/billing')

    await expect(page.getByRole('heading', { name: /team plan/i })).toBeVisible({ timeout: 15000 })
    await expect(page.getByText(/3 seats/i)).toBeVisible()

    const manageBtn = page.getByRole('button', { name: /manage billing/i })
    await expect(manageBtn).toBeVisible()
    await expect(manageBtn).toBeEnabled()

    // Team members section (only rendered for tier === 'team') should also
    // be present, with the owner's own invite form.
    await expect(page.getByRole('heading', { name: 'Team members' })).toBeVisible()
  })
})
