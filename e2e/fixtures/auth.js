import { expect } from '@playwright/test'

// App.jsx's post-login redirect isn't a single hop: AuthContext sets `user`
// (from the SIGNED_IN auth event) slightly before `profile` finishes its
// own fetch, so the very first route decision can transiently treat a
// fully-onboarded account as "not onboarded" (routeForUser sees
// profile=null), landing on /onboarding for an instant; then OnboardingRoute
// re-evaluates once profile arrives and bounces to /dashboard; then, for an
// account with no network yet, ProtectedRoute bounces
// AGAIN to /get-started — all as client-side <Navigate> replaces with no
// network round-trip between them, so the URL can visibly flicker through
// /onboarding -> /dashboard -> /get-started within tens of milliseconds. Waiting
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
// next, landing on /dashboard.
//
// 2026-09-05: there used to be a third possible landing here — /import, whose
// "Skip for now" link this helper clicked. That link wrote
// profiles.linkedin_import_completed = true, which was the dashboard's own
// admission gate, so clicking it was enough to get any account in. The gate is
// now the fact of having a network (a connected mailbox, or contacts), so
// there is nothing a test can click past: an account that reaches
// /get-started genuinely has no network and belongs there. Every account this
// helper is used with — owner, admin — has contacts, so none of them sees it.
// See src/lib/networkGate.js, and 04-newuser-... for the account that does.
export async function loginAndReachDashboard(page, email, password) {
  await page.goto('/login')
  await page.locator('#login-email').fill(email)
  await page.locator('#login-password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()

  // First wait for ANY departure from /login, then let the redirect chain
  // above finish flickering before trusting the URL at all.
  await page.waitForURL(url => !url.pathname.startsWith('/login'), { timeout: 20000 })
  await waitForStableUrl(page)

  await expect(page).toHaveURL(/\/dashboard/)
}
