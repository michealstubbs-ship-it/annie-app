import { test, expect } from '@playwright/test'
import { OWNER_AUTH_FILE } from '../fixtures/accounts.js'

test.use({ storageState: OWNER_AUTH_FILE })

// Scenario 5: core CRM CRUD as the owner. Exercises CLAUDE.md's
// "everything links through a dropdown" rule — the real assertion isn't
// just "the row was created", it's that the Contact created from inside
// the Company's own modal actually shows that company's name afterward
// (proving the link, not just a blank/free-text field).
const stamp = Date.now()
const COMPANY_NAME = `E2E-Co-${stamp}`
const CONTACT_NAME = `E2E Contact ${stamp}`
const JOB_TITLE = `E2E Job ${stamp}`
const CANDIDATE_NAME = `E2E Candidate ${stamp}`

test.describe('Core CRM CRUD as the owner', () => {
  test('create a Company, a linked Contact, a linked Job, and a Candidate', async ({ page }) => {
    await test.step('create a Company', async () => {
      await page.goto('/dashboard/companies')
      await page.getByRole('button', { name: '+ Add Company' }).click()
      await page.locator('#co-edit-name').fill(COMPANY_NAME)
      await page.locator('#co-edit-industry').fill('Technology')
      await page.getByRole('button', { name: 'Save' }).click()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(page.getByText(COMPANY_NAME)).toBeVisible()
    })

    await test.step('open the Company and add a Contact linked to it via the dropdown', async () => {
      await page.getByText(COMPANY_NAME, { exact: true }).click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await page.getByRole('button', { name: `+ Add contact at ${COMPANY_NAME}` }).click()
      await page.locator('#contact-name').fill(CONTACT_NAME)
      await page.locator('#contact-title').fill('VP of Something')
      await page.getByRole('button', { name: 'Save' }).click()
      // Back on the company detail modal, the new contact is listed under it.
      await expect(page.getByText(CONTACT_NAME)).toBeVisible()
      await page.keyboard.press('Escape') // close company detail modal
    })

    await test.step('the Contacts list shows the real company name, not blank — proves the dropdown link worked', async () => {
      await page.goto('/dashboard/contacts')
      const row = page.locator('tr', { hasText: CONTACT_NAME })
      await expect(row).toBeVisible()
      await expect(row).toContainText(COMPANY_NAME)
    })

    await test.step('create a Job linked to the same Company via CompanySelect', async () => {
      await page.goto('/dashboard/jobs')
      await page.getByRole('button', { name: '+ Add Job' }).click()
      await page.locator('#job-title').fill(JOB_TITLE)
      // Companies.jsx's <option> renders "Name (Industry)" when an industry
      // is set — this Company was created with industry "Technology" above.
      await page.locator('#company-select').selectOption({ label: `${COMPANY_NAME} (Technology)` })
      await page.getByRole('button', { name: 'Save job' }).click()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      const jobCard = page.locator('.card', { hasText: JOB_TITLE })
      await expect(jobCard).toBeVisible()
      await expect(jobCard).toContainText(COMPANY_NAME)
    })

    await test.step('create a Candidate', async () => {
      await page.goto('/dashboard/candidates')
      await page.getByRole('button', { name: '+ Add Candidate' }).click()
      await page.locator('#candidate-name').fill(CANDIDATE_NAME)
      await page.locator('#candidate-role').fill('Software Engineer')
      await page.getByRole('button', { name: 'Save candidate' }).click()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(page.getByText(CANDIDATE_NAME)).toBeVisible()
    })
  })
})
