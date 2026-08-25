import { test, expect } from '@playwright/test'
import { NEWUSER } from '../fixtures/accounts.js'

// Scenarios 4 + 10 (kept in one file since they're genuinely sequential —
// Billing's empty state only becomes reachable at all once onboarding +
// the LinkedIn-import step are both done, per App.jsx's ProtectedRoute).
//
// e2e-newuser starts with onboarding_completed=false and no subscription.
// This walks the real 5-step wizard (src/pages/Onboarding.jsx: Firm ->
// Sectors -> Functions -> Markets -> Your Style), skips the LinkedIn
// import step that follows it, lands on the dashboard, then checks Billing's
// "no active plan yet" empty state.
test.describe('Fresh user onboarding wizard, then Billing empty state', () => {
  test('e2e-newuser completes onboarding and reaches the dashboard; Billing shows the trial pitch and all 3 tiers', async ({ page }) => {
    await test.step('log in as the fresh, un-onboarded user', async () => {
      await page.goto('/login')
      await page.locator('#login-email').fill(NEWUSER.email)
      await page.locator('#login-password').fill(NEWUSER.password)
      await page.getByRole('button', { name: 'Sign in' }).click()
      await expect(page).toHaveURL(/\/onboarding/, { timeout: 20000 })
    })

    await test.step('Step 1 — Your Firm', async () => {
      await expect(page.getByText('Tell us about your firm')).toBeVisible()
      await page.locator('#onboarding-firm-name').fill('E2E Fresh Firm')
      await page.getByRole('button', { name: 'Continue' }).click()
    })

    await test.step('Step 2 — Sectors', async () => {
      await expect(page.getByText('Which sectors do you recruit in?')).toBeVisible()
      await page.getByRole('button', { name: 'Technology', exact: true }).click()
      await page.getByRole('button', { name: 'Continue' }).click()
    })

    await test.step('Step 3 — Functions', async () => {
      await expect(page.getByText('Which functions do you place people into?')).toBeVisible()
      await page.getByRole('button', { name: 'Finance & Accounting', exact: true }).click()
      await page.getByRole('button', { name: 'Continue' }).click()
    })

    await test.step('Step 4 — Markets', async () => {
      await expect(page.getByText('Where are your target markets?')).toBeVisible()
      await page.getByRole('button', { name: 'United Kingdom', exact: true }).click()
      await page.getByRole('button', { name: 'Continue' }).click()
    })

    await test.step('Step 5 — Your Style, then Launch Annie', async () => {
      await expect(page.getByText('How do you communicate?')).toBeVisible()
      await page.getByRole('button', { name: /Warm/ }).click()
      await page.getByRole('button', { name: 'Launch Annie' }).click()
    })

    await test.step('lands on /import (LinkedIn import), skip it', async () => {
      await page.waitForURL(/\/import/, { timeout: 30000 })
      await page.getByRole('button', { name: /skip for now/i }).click()
    })

    await test.step('reaches the dashboard', async () => {
      await page.waitForURL(/\/dashboard/, { timeout: 20000 })
      await expect(page).toHaveURL(/\/dashboard$/)
    })

    await test.step('Billing shows the "every plan starts with a trial" empty state, all 3 tiers', async () => {
      await page.goto('/dashboard/billing')
      await expect(page.getByText(/7-day free trial/i)).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Starter' })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Growth' })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Team' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Start free trial' }).first()).toBeVisible()
    })
  })
})
