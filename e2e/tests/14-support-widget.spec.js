import { test, expect } from '@playwright/test'
import { OWNER_AUTH_FILE } from '../fixtures/accounts.js'

test.use({ storageState: OWNER_AUTH_FILE })

// Scenario 14: the support widget (src/components/SupportWidget.jsx) is
// mounted globally for any logged-in user (App.jsx). Send one message and
// confirm the UI round-trips to SOME reply — not asserting on exact AI
// wording, just that a reply bubble with real text appears (or the
// widget's own graceful fallback text, "That didn't go through on my
// end...", if the chat backend errors) rather than hanging forever.
//
// Note: the loading (three-dot bounce) indicator bubble shares the exact
// same CSS classes as a real message bubble (both are
// `bg-white border border-gray-100 rounded-2xl rounded-bl-sm`), so
// `.last()` can transiently resolve to the empty loading bubble rather
// than the real reply — poll for non-empty text rather than a one-shot
// visibility check.
test.describe('Support widget', () => {
  test('sending a message produces some acknowledgment', async ({ page }) => {
    await page.goto('/dashboard')

    await page.getByRole('button', { name: 'Get help' }).click()
    const input = page.getByPlaceholder('Ask a question...')
    await expect(input).toBeVisible()

    await input.fill('How do I re-run my LinkedIn import?')
    await page.getByRole('button', { name: 'Send' }).click()

    // The user's own message echoes immediately.
    await expect(page.getByText('How do I re-run my LinkedIn import?')).toBeVisible()

    const replyBubbles = page.locator('div.bg-white.border.border-gray-100.rounded-2xl.rounded-bl-sm')
    let replyText = ''
    await expect.poll(async () => {
      const count = await replyBubbles.count()
      if (count === 0) return ''
      replyText = ((await replyBubbles.last().textContent()) || '').trim()
      return replyText
    }, { timeout: 30_000, message: 'waiting for a non-empty assistant reply bubble (not just the loading indicator)' }).not.toBe('')

    expect(replyText.length).toBeGreaterThan(0)
    console.log(`[scenario 14] support widget replied: ${replyText.slice(0, 200)}`)
  })
})
