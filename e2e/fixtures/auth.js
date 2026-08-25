import { expect } from '@playwright/test'

// App.jsx's post-login redirect isn't a single hop: AuthContext sets `user`
// (from the SIGNED_IN auth event) slightly before `profile` finishes its
// own fetch, so the very first route decision can transiently treat a
// fully-onboarded account as "not onboarded" (routeForUser sees
// profile=null), landing on /onboarding for an instant; then OnboardingRoute
// re-evaluates once profile arrives and bounces to /dashboard; then, for an
// account that hasn't done the LinkedIn-import step, ProtectedRoute bounces
// AGAIN to /import — all as client-side <Navigate> replaces with no network
// round-trip between them, so the URL can visibly flicker through
// /onboarding -> /dashboard -> /import within tens of milliseconds. Waiting
// for "the URL matches something plausible" is not enough — it has to
// settle. This polls the URL until it stops changing.
async function waitForStableUrl(page, { timeout = 20000, quietMs = 500 } = {}) {
  const deadline = Date.now() + timeout
  let last = page.url()
  while (Date.now() < deadline) {
    await page.waitForTimeout(quietMs)
    const current = page.url()
    if (current === last) return current
    last = current
  }
  return last
}

// Logs in through the real /login form (selectors confirmed against
// src/pages/Login.jsx: #login-email / #login-password / submit button
// text "Sign in"), then follows wherever App.jsx's routing sends the user
// next — /onboarding, /import (LinkedIn import skip), or straight to
// /dashboard — landing on /dashboard either way. Used by global setup (to
// cache owner/admin storageState) and directly by specs that log in fresh
// (the brand-new-account scenarios where a cached state doesn't apply).
export async function loginAndReachDashboard(page, email, password) {
  await page.goto('/login')
  await page.locator('#login-email').fill(email)
  await page.locator('#login-password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()

  // First wait for ANY departure from /login, then let the redirect chain
  // above finish flickering before trusting the URL at all.
  await page.waitForURL(url => !url.pathname.startsWith('/login'), { timeout: 20000 })
  const settledUrl = await waitForStableUrl(page)

  if (new URL(settledUrl).pathname.startsWith('/import')) {
    // LinkedInImport's top-level (non-embedded) "skip" link, per
    // src/pages/LinkedInImport.jsx — sets linkedin_import_completed=true
    // and navigates to /dashboard itself.
    await page.getByRole('button', { name: /skip for now/i }).click()
    await page.waitForURL(url => url.pathname.startsWith('/dashboard'), { timeout: 20000 })
  }

  await expect(page).toHaveURL(/\/dashboard/)
}
