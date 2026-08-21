import React from 'react'
import { Link } from 'react-router-dom'

// See Terms.jsx's header comment — same status: a genuine v1, not a
// substitute for real legal review, especially given third-party contact
// data (names, titles, LinkedIn URLs, emails) processed about people who
// never directly opted into being tracked by Annie. This is the single
// biggest reason to get an actual lawyer's eyes on this before treating it
// as your real, final policy.
export default function Privacy() {
  return (
    <div className="min-h-screen bg-page-bg px-4 py-10">
      <div className="max-w-2xl mx-auto">
        <Link to="/login" className="text-sm text-gold-ink font-semibold hover:underline">← Back to Annie</Link>
        <div className="card p-8 mt-4">
          <h1 className="text-2xl font-bold text-navy mb-1">Privacy Policy</h1>
          <p className="text-xs text-gray-400 mb-6">Last updated 21 August 2026</p>

          <div className="space-y-5 text-sm text-gray-700 leading-relaxed">
            <section>
              <h2 className="font-bold text-navy mb-1">What we collect</h2>
              <p>Account information you provide (name, firm name, email). Contacts and companies you import or add, including any you import from LinkedIn. Business signals Annie's research surfaces about companies and contacts in your target sectors — company names, public news, job postings, and publicly available contact details (name, title, LinkedIn URL) for people at those companies. Basic diagnostic data when something goes wrong (error messages, the page it happened on) so we can fix it.</p>
            </section>
            <section>
              <h2 className="font-bold text-navy mb-1">Where contact data comes from</h2>
              <p>Some of the people in Annie's research (contacts at companies it surfaces as opportunities) have not directly given Annie their information — it comes from public sources (company websites, LinkedIn, news coverage, public job postings) or from data you import yourself. We process this on the basis of legitimate business interest — identifying genuine business-development opportunities for recruitment purposes — and only what's reasonably necessary for that (typically name, job title, and a public professional profile URL, never anything sensitive).</p>
            </section>
            <section>
              <h2 className="font-bold text-navy mb-1">How we use it</h2>
              <p>To run Annie's core function: researching and surfacing business signals for your firm, and letting you manage the resulting pipeline. To improve the product (aggregated, not sold or shared for third-party marketing). To provide support when you ask for it.</p>
            </section>
            <section>
              <h2 className="font-bold text-navy mb-1">Third parties we share data with</h2>
              <p>Supabase (database and authentication hosting), Netlify (application hosting), Anthropic (AI research), Apollo.io (contact and company enrichment), Adzuna (job listings), the UK's Companies House (public company records), Resend (sending account emails, such as onboarding confirmation and billing alerts), and PostHog (product analytics — see "Cookies & analytics" below). If you're on a paid plan, Stripe processes your payment; we never see or store your card details ourselves. Each only receives what it needs to perform its function — we don't sell data to advertisers or data brokers.</p>
            </section>
            <section>
              <h2 className="font-bold text-navy mb-1">Cookies & analytics</h2>
              <p>We use PostHog to understand how Annie is used — which pages get visited, which features get clicked — so we can improve the product. This sets a small number of cookies and is tied to your account once you're logged in, not to anonymous visitors browsing the marketing site. It's not used for advertising, and we don't sell this data. You can ask us to stop this tracking for your account by contacting us (see below).</p>
            </section>
            <section>
              <h2 className="font-bold text-navy mb-1">International data transfers</h2>
              <p>Our hosting and analytics providers operate infrastructure in multiple regions, including the EU, UK, and US. Data may be processed outside the country you're based in as a result. Each provider we use maintains its own safeguards for cross-border transfers (such as standard contractual clauses where applicable) as part of its own compliance obligations.</p>
            </section>
            <section>
              <h2 className="font-bold text-navy mb-1">Your rights</h2>
              <p>You can export or request deletion of your account's data at any time from Settings → Data & Privacy. If you're a contact Annie has surfaced and never worked with us directly, you can request removal by contacting us through the email address on our site — we'll act on it within a reasonable time.</p>
            </section>
            <section>
              <h2 className="font-bold text-navy mb-1">Retention</h2>
              <p>We keep account and pipeline data for as long as your account is active, and business-signal data for as long as it's useful for BD purposes unless you delete it sooner. Deleted accounts are removed from our active database; some records may persist briefly in backups before they age out.</p>
            </section>
            <section>
              <h2 className="font-bold text-navy mb-1">Security</h2>
              <p>Data is encrypted in transit and at rest through our hosting providers. Access within your firm's account is scoped so one customer's data is never visible to another.</p>
            </section>
            <section>
              <h2 className="font-bold text-navy mb-1">Children</h2>
              <p>Annie is a business tool for recruitment professionals and isn't directed at or knowingly used by anyone under 18.</p>
            </section>
            <section>
              <h2 className="font-bold text-navy mb-1">Changes</h2>
              <p>We'll update this policy as the product evolves and note the date at the top when we do.</p>
            </section>
            <section>
              <h2 className="font-bold text-navy mb-1">Contact</h2>
              <p>Reach us through the in-app support chat, or the email address you used to sign up, for any privacy question or request.</p>
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}
