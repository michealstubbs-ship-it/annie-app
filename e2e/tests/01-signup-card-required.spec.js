import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { uniqueEmail, STRIPE_TEST_CARD } from '../fixtures/accounts.js'

// Scenario 1: new trial signup via the marketing-site entry point
// (netlify/functions/start-trial-checkout.js), no discount code. This is
// the flow that had a real bug earlier (card being skipped when it
// shouldn't — see that file's 2026-08-24 comment): normal signups must
// always collect a card up front, even though a 7-day trial makes $0 due
// today. So the core assertion here isn't just "it ends up trialing" —
// it's that Stripe's own Checkout page actually shows card-entry fields
// before we ever get there.
//
// The backend outcome (a new auth.users/profiles row + a subscriptions row
// with tier='starter', status='trialing', created by stripe-webhook.js's
// checkout.session.completed handler) is verified separately via the
// Supabase MCP tool after this run, not from inside this Playwright
// process (which has no DB credentials of its own) — see GENERATED_EMAILS_FILE.
const GENERATED_EMAILS_FILE = path.join(process.cwd(), 'e2e', 'test-results', 'generated-emails.json')

function recordGeneratedEmail(scenario, email) {
  fs.mkdirSync(path.dirname(GENERATED_EMAILS_FILE), { recursive: true })
  const existing = fs.existsSync(GENERATED_EMAILS_FILE) ? JSON.parse(fs.readFileSync(GENERATED_EMAILS_FILE, 'utf8')) : {}
  existing[scenario] = email
  fs.writeFileSync(GENERATED_EMAILS_FILE, JSON.stringify(existing, null, 2))
}

test.describe('New trial signup — starter, no discount, card required', () => {
  test('Stripe Checkout demands a card, and completing it reaches the success page', async ({ page }) => {
    const email = uniqueEmail('e2e-signup-starter')
    recordGeneratedEmail('scenario1_starter_no_discount', email)
    console.log(`[scenario 1] generated signup email: ${email}`)

    await test.step('follow the marketing-site checkout entry point to Stripe', async () => {
      await page.goto('/api/start-trial-checkout?tier=starter&interval=month')
      await expect(page).toHaveURL(/checkout\.stripe\.com/, { timeout: 20000 })
    })

    await test.step('assert the card-required fix holds: card fields are present, not skipped', async () => {
      await expect(page.locator('#cardNumber')).toBeVisible({ timeout: 20000 })
      await expect(page.locator('#cardExpiry')).toBeVisible()
      await expect(page.locator('#cardCvc')).toBeVisible()
    })

    await test.step('fill in email + Stripe test card and submit', async () => {
      await page.locator('#email').fill(email)
      await page.locator('#cardNumber').fill(STRIPE_TEST_CARD.number)
      await page.locator('#cardExpiry').fill(STRIPE_TEST_CARD.expiry)
      await page.locator('#cardCvc').fill(STRIPE_TEST_CARD.cvc)
      // Name/ZIP only render if Checkout's billing-details config asks for
      // them — guard rather than assume, so a config change doesn't fail
      // this test for an unrelated reason.
      const nameField = page.locator('#billingName')
      if (await nameField.isVisible().catch(() => false)) await nameField.fill(STRIPE_TEST_CARD.name)
      const zipField = page.locator('#billingPostalCode')
      if (await zipField.isVisible().catch(() => false)) await zipField.fill(STRIPE_TEST_CARD.zip)

      // Stripe's own Link enrollment ("Save my information for faster
      // checkout") appears once a card number is entered and, when left
      // checked, requires a verified phone number before the form will
      // submit — unrelated to Annie's own checkout config, and not
      // something a real first-time signup is required to opt into.
      // Uncheck it so submission isn't blocked on a phone-verification
      // step this scenario isn't testing.
      const saveInfoCheckbox = page.locator('#enableStripePass')
      if (await saveInfoCheckbox.isVisible().catch(() => false)) {
        if (await saveInfoCheckbox.isChecked()) await saveInfoCheckbox.uncheck()
      }

      await page.locator('[data-testid="hosted-payment-submit-button"]').click()
    })

    await test.step('lands on /welcome?checkout=success with confirmation copy', async () => {
      await page.waitForURL(/\/welcome\?checkout=success/, { timeout: 30000 })
      await expect(page.getByText(/check your email/i)).toBeVisible()
      await expect(page.getByText(/trial has started/i)).toBeVisible()
    })
  })
})
