import { test, expect } from '@playwright/test'
import { OWNER_AUTH_FILE } from '../fixtures/accounts.js'

test.use({ storageState: OWNER_AUTH_FILE })

// Scenario 8: Settings' read-only BD Configuration summary should reflect
// what onboarding actually set for e2e-owner (sectors: Technology,
// functions: Finance, locations: United Kingdom — per the fixture). Then
// trigger a manual scan and accept ANY of the real backend outcomes
// (ok / no_results / cooldown / still_running / error) rather than
// assuming which one a shared staging fixture will hit on a given run.
test.describe('Settings', () => {
  test('shows the onboarding summary and a manual scan produces a real status message', async ({ page }) => {
    // Scans against a real research pipeline can run up to ~3 minutes of
    // local polling (Settings.jsx's LOCAL_POLL_WINDOW_MS) before falling
    // back to "still_running" — give this test the room to actually see
    // that resolve instead of timing out mid-poll.
    test.setTimeout(4 * 60 * 1000)

    await page.goto('/dashboard/settings')

    await test.step('BD Configuration reflects onboarding', async () => {
      const section = page.locator('.card', { hasText: 'BD Configuration' })
      await expect(section).toBeVisible()
      await expect(section.getByText('Technology')).toBeVisible()
      await expect(section.getByText(/Finance/)).toBeVisible()
      await expect(section.getByText('United Kingdom')).toBeVisible()
    })

    await test.step('manual "Run a new scan" produces a real, recognizable status', async () => {
      const section = page.locator('.card', { hasText: 'Research scan' })
      await section.getByRole('button', { name: /run a new scan/i }).click()
      await expect(section.getByRole('button', { name: /annie is researching/i })).toBeVisible()

      const finalMessage = section.locator('p.text-sm.mt-3')
      await expect(finalMessage).toBeVisible({ timeout: 3.5 * 60 * 1000 })
      const text = (await finalMessage.textContent()) || ''
      const recognized = /found \d+ new signal|didn't find anything strong enough|already ran a scan for you recently|hit an error reaching her research tools|still researching|scan finished/i.test(text)
      expect(recognized, `unrecognized scan result message: "${text}"`).toBeTruthy()
      console.log(`[scenario 8] scan result message: ${text}`)
    })
  })
})
