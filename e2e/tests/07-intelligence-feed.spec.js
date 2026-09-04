import { test, expect } from '@playwright/test'
import { OWNER_AUTH_FILE } from '../fixtures/accounts.js'

test.use({ storageState: OWNER_AUTH_FILE })

// Scenario 7: the one stream should render without error even with little or
// no real signal data on this staging account (no LinkedIn import, no research
// scan has necessarily run for it) — a sane empty state, not a crash.
test.describe('Intelligence Feed', () => {
  test('Intelligence Feed renders (data or empty state), no crash', async ({ page }) => {
    await page.goto('/dashboard/intelligence-feed')
    // The page-level ErrorBoundary card is the one thing that must NOT show.
    await expect(page.getByText('Something went wrong')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: /intelligence feed/i })).toBeVisible({ timeout: 20000 })
    // Either real signal cards, or the tab bar simply renders with nothing
    // under it — both are "rendered sanely". Assert the tab structure itself
    // came up, which only happens after data has loaded without throwing.
    await expect(page.getByRole('button', { name: /everything/i })).toBeVisible()
  })

  // 2026-09-04: Today's Actions no longer exists as a page. It merged into the
  // Intelligence Feed, which now shows every lead rather than only the ones
  // Apollo had already found a contact for. What this test guards is that the
  // old path still lands somewhere real — bookmarks, the support widget's copy
  // and links in already-sent emails all point at it.
  test('the retired /dashboard/actions path redirects into the Feed', async ({ page }) => {
    await page.goto('/dashboard/actions')
    await expect(page).toHaveURL(/\/dashboard\/intelligence-feed$/, { timeout: 20000 })
    await expect(page.getByText('Something went wrong')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: /intelligence feed/i })).toBeVisible({ timeout: 20000 })
  })

  test('the stream renders its views and never crashes on an empty account', async ({ page }) => {
    await page.goto('/dashboard/intelligence-feed')
    await expect(page.getByText('Something went wrong')).toHaveCount(0)
    // The view tabs are rendered from the stream itself, so their presence
    // means the data layer resolved without throwing.
    await expect(page.getByRole('button', { name: /everything/i })).toBeVisible({ timeout: 20000 })
    await expect(page.getByRole('button', { name: /with a route in/i })).toBeVisible()
    // Either real cards, or the honest empty state. Both are a sane render.
    await expect(
      page.getByText(/no route in yet|in your contacts|spoken to someone here|nothing here yet/i).first()
    ).toBeVisible({ timeout: 45000 })
  })
})
