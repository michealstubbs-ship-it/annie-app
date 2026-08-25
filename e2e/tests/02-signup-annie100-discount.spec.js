import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { uniqueEmail } from '../fixtures/accounts.js'

const GENERATED_EMAILS_FILE = path.join(process.cwd(), 'e2e', 'test-results', 'generated-emails.json')
function recordGeneratedEmail(scenario, email) {
  fs.mkdirSync(path.dirname(GENERATED_EMAILS_FILE), { recursive: true })
  const existing = fs.existsSync(GENERATED_EMAILS_FILE) ? JSON.parse(fs.readFileSync(GENERATED_EMAILS_FILE, 'utf8')) : {}
  existing[scenario] = email
  fs.writeFileSync(GENERATED_EMAILS_FILE, JSON.stringify(existing, null, 2))
}

// Scenario 2: the same entry point, but with the annie100 promo code
// pre-applied via ?code=annie100 — start-trial-checkout.js's own logic
// (see its 2026-08-24 comment) means this is the ONLY case where the card
// is skipped: a known ?code= link the operator hands out directly, where
// the discount is applied server-side before the session exists, as
// opposed to a customer self-typing a code into Checkout's own promo-code
// box (which never skips the card, since Checkout can't retroactively
// change payment_method_collection based on client-side input).
test.describe('New trial signup — growth, annie100 discount, card skipped', () => {
  test('Stripe Checkout skips card entry entirely and shows the 100% discount', async ({ page }) => {
    const email = uniqueEmail('e2e-signup-annie100')
    recordGeneratedEmail('scenario2_growth_annie100', email)
    console.log(`[scenario 2] generated signup email: ${email}`)

    await test.step('follow the annie100 checkout link to Stripe', async () => {
      await page.goto('/api/start-trial-checkout?tier=growth&interval=month&code=annie100')
      await expect(page).toHaveURL(/checkout\.stripe\.com/, { timeout: 20000 })
    })

    await test.step('card fields are NOT present — only email is asked for', async () => {
      await expect(page.locator('#email')).toBeVisible({ timeout: 20000 })
      await expect(page.locator('#cardNumber')).toHaveCount(0)
      await expect(page.locator('#cardExpiry')).toHaveCount(0)
      await expect(page.locator('#cardCvc')).toHaveCount(0)
    })

    await test.step('the 100% off discount is shown and the CTA reads "Start trial"', async () => {
      await expect(page.getByText(/100%\s*off/i)).toBeVisible()
      await expect(page.locator('[data-testid="hosted-payment-submit-button"]')).toContainText(/start trial/i)
    })

    await test.step('submit with just the email — no payment method needed', async () => {
      await page.locator('#email').fill(email)
      await page.locator('[data-testid="hosted-payment-submit-button"]').click()
    })

    await test.step('lands on /welcome?checkout=success with confirmation copy', async () => {
      await page.waitForURL(/\/welcome\?checkout=success/, { timeout: 30000 })
      await expect(page.getByText(/check your email/i)).toBeVisible()
      await expect(page.getByText(/trial has started/i)).toBeVisible()
    })
  })
})
