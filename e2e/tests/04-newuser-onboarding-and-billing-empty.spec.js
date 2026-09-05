import { test, expect } from '@playwright/test'
import { NEWUSER } from '../fixtures/accounts.js'

// Scenarios 4 + 10 (kept in one file since they're genuinely sequential —
// Billing's empty state only becomes reachable at all once onboarding is done
// AND the account has a network, per App.jsx's ProtectedRoute).
//
// e2e-newuser starts with onboarding_completed=false, no contacts and no
// subscription. This walks the real 5-step wizard (src/pages/Onboarding.jsx:
// Firm -> Sectors -> Functions -> Markets -> Your Style), then gets past
// /get-started the way a recruiter who will not connect a mailbox does — by
// uploading a contacts export — lands on the dashboard, and checks Billing's
// "no active plan yet" empty state.
//
// NOTE this test now leaves one contact behind on e2e-newuser, which is what
// makes the account admissible on every later run.
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

    // 2026-09-05: this step used to be "lands on /import, click Skip for now".
    // That link wrote profiles.linkedin_import_completed = true, which WAS the
    // dashboard's admission gate — so the test walked the same path most real
    // customers did: skip, and arrive with no network at a product that only
    // works with one. There is nothing to skip any more. The account has to
    // actually get a network, and this is the refuser's route: the contacts
    // export, which Annie reads from anywhere, not only LinkedIn.
    await test.step('lands on /get-started and takes the upload route, not the mailbox', async () => {
      await page.waitForURL(/\/get-started/, { timeout: 30000 })
      await expect(page.getByText('Give Annie something to watch')).toBeVisible()
      await page.getByRole('button', { name: 'Upload a contacts export' }).click()

      // A title that clears the function filter this account chose at step 3
      // (Finance & Accounting) and the default C-Suite seniority band, at a
      // company name that signals no sector or market of its own, connected
      // recently enough for the default five-year window.
      const connectedOn = new Date(Date.now() - 30 * 86400000).toDateString()
      const csv = [
        'First Name,Last Name,Email Address,Company,Position,Connected On',
        `Nadia,Whitfield,nadia.whitfield@example.com,Vantara,Chief Financial Officer,${connectedOn}`,
      ].join('\n')

      await page.locator('input[type="file"]').setInputFiles({
        name: 'contacts.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8'),
      })

      await page.getByRole('button', { name: /^Import 1 contact/ }).click()
      await expect(page.getByText("You're all set")).toBeVisible({ timeout: 30000 })
      await page.getByRole('button', { name: 'Go to my dashboard' }).click()
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
