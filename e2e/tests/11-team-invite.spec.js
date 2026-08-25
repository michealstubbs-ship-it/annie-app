import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { OWNER_AUTH_FILE, uniqueEmail } from '../fixtures/accounts.js'

test.use({ storageState: OWNER_AUTH_FILE })

const GENERATED_EMAILS_FILE = path.join(process.cwd(), 'e2e', 'test-results', 'generated-emails.json')
function recordGeneratedEmail(scenario, email) {
  fs.mkdirSync(path.dirname(GENERATED_EMAILS_FILE), { recursive: true })
  const existing = fs.existsSync(GENERATED_EMAILS_FILE) ? JSON.parse(fs.readFileSync(GENERATED_EMAILS_FILE, 'utf8')) : {}
  existing[scenario] = email
  fs.writeFileSync(GENERATED_EMAILS_FILE, JSON.stringify(existing, null, 2))
}

// Scenario 11: real team invite through the actual UI + backend
// (Billing.jsx's sendInvite -> POST /api/team-invite -> netlify/functions/team-invite.js).
// The UI-visible success notice is asserted here; the resulting
// team_members row (status='invited', team_id = owner's team) is verified
// separately via the Supabase MCP tool after this run.
test.describe('Team invite', () => {
  test('inviting a fresh email shows a success notice', async ({ page }) => {
    const email = uniqueEmail('e2e-invite')
    recordGeneratedEmail('scenario11_team_invite', email)
    console.log(`[scenario 11] generated invite email: ${email}`)

    await page.goto('/dashboard/billing')
    await expect(page.getByRole('heading', { name: 'Team members' })).toBeVisible({ timeout: 15000 })

    const inviteInput = page.getByPlaceholder('teammate@yourfirm.com')
    await inviteInput.fill(email)
    await page.getByRole('button', { name: /^invite$/i }).click()

    await expect(page.getByText(/invite sent|added to your team/i)).toBeVisible({ timeout: 20000 })
    // The invited email now shows up in the roster with "Invite pending".
    const row = page.locator('li', { hasText: email })
    await expect(row).toBeVisible()
    await expect(row).toContainText(/invite pending/i)
  })
})
