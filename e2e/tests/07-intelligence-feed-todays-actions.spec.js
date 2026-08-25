import { test, expect } from '@playwright/test'
import { OWNER_AUTH_FILE } from '../fixtures/accounts.js'

test.use({ storageState: OWNER_AUTH_FILE })

// Scenario 7: both pages should render without error even with little/no
// real signal data on this staging account (no LinkedIn import, no research
// scan has necessarily run for it) — a sane empty state, not a crash.
test.describe('Intelligence Feed + Today\'s Actions', () => {
  test('Intelligence Feed renders (data or empty state), no crash', async ({ page }) => {
    await page.goto('/dashboard/intelligence-feed')
    // The page-level ErrorBoundary card is the one thing that must NOT show.
    await expect(page.getByText('Something went wrong')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: /intelligence feed/i })).toBeVisible({ timeout: 20000 })
    // Either real signal cards, or the tab bar simply renders with nothing
    // under it — both are "rendered sanely". Assert the tab structure itself
    // came up, which only happens after data has loaded without throwing.
    await expect(page.getByText(/signals/i).first()).toBeVisible()
  })

  test('Today\'s Actions renders (data or empty state), no crash', async ({ page }) => {
    await page.goto('/dashboard/actions')
    await expect(page.getByText('Something went wrong')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: /good morning/i })).toBeVisible({ timeout: 20000 })

    // It auto-generates on load (useTodaysActions' initial refresh({silent:false})).
    // Wait for it to settle into one of: populated tabs, an explicit "nothing
    // right now" empty card, an error banner, or (if it never auto-fired) the
    // manual "Show Today's Actions" prompt — any of these is a sane, non-crashed
    // render for a fresh account with little signal data.
    await expect(
      page.getByText(/today's bd actions|worth your follow up|no new bd signals|nothing needs following up|ready to see today's actions|nothing urgent today/i).first()
    ).toBeVisible({ timeout: 45000 })
  })
})
