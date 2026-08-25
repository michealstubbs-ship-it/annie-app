import { test, expect } from '@playwright/test'
import { OWNER_AUTH_FILE } from '../fixtures/accounts.js'

test.use({ storageState: OWNER_AUTH_FILE })

const stamp = Date.now()
const DEAL_COMPANY = `E2E-Deal-${stamp}`
const MEETING_TITLE = `E2E Meeting ${stamp}`
const TASK_TITLE = `E2E Task ${stamp}`

// Scenario 6: BD Pipeline is its own independent deals table (lib/data/deals.js),
// not derived from Companies/Contacts/Jobs — confirmed by reading Pipeline.jsx,
// which has its own Add Deal form keyed only on a free-text company name. So
// this adds one pipeline item directly, plus one Meeting and one Task.
test.describe('Pipeline, Meetings, Tasks', () => {
  test('add one pipeline deal, log one meeting, create one task — each shows up', async ({ page }) => {
    await test.step('add a pipeline deal', async () => {
      await page.goto('/dashboard/pipeline')
      await page.getByRole('button', { name: '+ Add Deal' }).click()
      await page.locator('#pipeline-company').fill(DEAL_COMPANY)
      await page.locator('#pipeline-role').fill('BD intro')
      await page.getByRole('button', { name: 'Save' }).click()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(page.getByText(DEAL_COMPANY)).toBeVisible()
    })

    await test.step('log a meeting', async () => {
      await page.goto('/dashboard/meetings')
      await page.getByRole('button', { name: '+ Log Meeting' }).click()
      await page.locator('#meeting-title').fill(MEETING_TITLE)
      // meeting-date is required and pre-filled with "now" by openAdd(), so
      // it's already valid — just submit.
      await page.getByRole('button', { name: 'Save' }).click()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(page.getByText(MEETING_TITLE)).toBeVisible()
    })

    await test.step('create a task', async () => {
      await page.goto('/dashboard/tasks')
      await page.getByRole('button', { name: '+ Add Task' }).click()
      await page.locator('#task-title').fill(TASK_TITLE)
      await page.getByRole('button', { name: 'Save' }).click()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(page.getByText(TASK_TITLE)).toBeVisible()
    })
  })
})
