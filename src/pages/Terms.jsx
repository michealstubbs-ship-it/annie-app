import React from 'react'
import { Link } from 'react-router-dom'

// Pre-launch audit flagged this as a real gap, not just a nice-to-have:
// Login.jsx referenced "our Terms of Service and Privacy Policy" as plain,
// unlinked text with nothing behind it to click. This is a genuine v1 — a
// real starting point, not filler — but it is NOT a substitute for review
// by an actual lawyer, especially given UK/EU customers and third-party
// contact data (names, titles, LinkedIn URLs, emails) processed without
// those individuals opting in directly. Get this reviewed before relying on
// it for real regulatory exposure.
export default function Terms() {
  return (
    <div className="min-h-screen bg-page-bg px-4 py-10">
      <div className="max-w-2xl mx-auto">
        <Link to="/login" className="text-sm text-gold-ink font-semibold hover:underline">← Back to Annie</Link>
        <div className="card p-8 mt-4">
          <h1 className="text-2xl font-bold text-navy mb-1">Terms of Service</h1>
          <p className="text-xs text-gray-400 mb-6">Last updated 21 August 2026</p>

          <div className="space-y-5 text-sm text-gray-700 leading-relaxed">
            <section>
              <h2 className="font-bold text-navy mb-1">1. What Annie is</h2>
              <p>Annie ("Annie", "we", "us") is a business-development intelligence tool for recruitment firms. It researches public information about companies and contacts to surface potential business opportunities, and helps you manage the resulting pipeline of contacts, companies, jobs, and deals.</p>
            </section>
            <section>
              <h2 className="font-bold text-navy mb-1">2. Your account</h2>
              <p>You're responsible for the accuracy of information you provide and for keeping your login credentials secure. You must be authorized to act on behalf of the firm you sign up under. One account is for one firm's use — don't share login credentials across separate organizations.</p>
            </section>
            <section>
              <h2 className="font-bold text-navy mb-1">3. AI-generated content</h2>
              <p>Annie uses AI, including live web search, to identify and describe business signals (funding rounds, leadership changes, hiring activity, and similar). This research is provided as a starting point for your own outreach, not as verified fact. Some signals are independently corroborated (for example against Companies House filings or live job postings) and are marked as such; anything not marked "verified" reflects the AI's own research and should be checked before you rely on it in a customer-facing way. We do not guarantee the accuracy, completeness, or timeliness of any signal.</p>
            </section>
            <section>
              <h2 className="font-bold text-navy mb-1">4. Acceptable use</h2>
              <p>Don't use Annie to harass, deceive, or spam the people or companies it surfaces. Don't attempt to circumvent usage limits, extract data in bulk for resale, or use the product in a way that could disrupt it for other customers.</p>
            </section>
            <section>
              <h2 className="font-bold text-navy mb-1">5. Your data</h2>
              <p>You own the contact, company, and pipeline data you add or import into Annie. See our <Link to="/privacy" className="text-gold-ink font-semibold hover:underline">Privacy Policy</Link> for how we handle it, including your right to request an export or deletion at any time from Settings.</p>
            </section>
            <section>
              <h2 className="font-bold text-navy mb-1">6. Trials, plans, and billing</h2>
              <p>Where a free trial is offered, its length and what happens afterward will be stated clearly at signup. We'll tell you before any charge is made — nothing is billed automatically without your explicit setup of a paid plan.</p>
            </section>
            <section>
              <h2 className="font-bold text-navy mb-1">7. Changes and termination</h2>
              <p>We may update these terms as the product evolves and will give reasonable notice of material changes. You can stop using Annie and request deletion of your data at any time; we may suspend accounts that violate section 4.</p>
            </section>
            <section>
              <h2 className="font-bold text-navy mb-1">8. Liability</h2>
              <p>Annie is provided "as is." Business decisions made from Annie's research are yours to make and verify — we're not liable for outreach sent, deals pursued, or opportunities missed based on information Annie surfaced.</p>
            </section>
            <section>
              <h2 className="font-bold text-navy mb-1">9. Eligibility</h2>
              <p>Annie is a business tool and isn't directed at or intended for anyone under 18.</p>
            </section>
            <section>
              <h2 className="font-bold text-navy mb-1">10. Governing law</h2>
              <p>These terms are governed by the laws of the United Arab Emirates, without regard to conflict-of-law principles.</p>
            </section>
            <section>
              <h2 className="font-bold text-navy mb-1">Questions</h2>
              <p>Reach us through the in-app support chat, or contact the email address you used to sign up.</p>
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}
