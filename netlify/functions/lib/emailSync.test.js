import { describe, it, expect } from 'vitest'
import {
  splitAddress, cleanDisplayName, nameFromAddress, classifyAddress,
  parseAwayUntil, detectAutoReply, detectBounce, parseSignature, pickCounterparty,
} from './emailSync.js'

// The fixtures below are the real thing. They were taken from a live recruiter
// mailbox on 2026-09-05 while designing this feature — 50 sent and 50 received
// messages. Where a test says "measured", it means the expectation was checked
// against what that mailbox actually contained, not against what seemed likely.

const OWN = {
  ownDomains: ['vantagesearchgroup.me', 'meetannie.ai'],
  ownAddresses: ['mstubbs@vantagesearchgroup.me'],
}

// Every distinct external counterparty in the measured sent folder.
const REAL_WORK_ADDRESSES = [
  'Christina.Westhuizen@e7group.ae',
  'hwild@adcouncil.ae',
  'balkhalaf@al-akaria.com',
  'saloqaily@al-akaria.com',
  'aalnuman@al-akaria.com',
  'Erwin.Dioso@taqa.com',
  'Aisha.AlHammadi@taqa.com',
  'malmakheeti@limad.com',
  'mzahid@limad.com',
  'oschleichert@sanamadvisory.com.sa',
  'kalkhalid@jash.com.sa',
]

// Every distinct noise sender in the measured inbox.
const REAL_NOISE_ADDRESSES = [
  'messaging-digest-noreply@linkedin.com',
  'messages-noreply@linkedin.com',
  'jobs-listings@linkedin.com',
  'jobs-noreply@linkedin.com',
  'newsletters-noreply@linkedin.com',
  'billing-noreply@linkedin.com',
  'hit-reply@linkedin.com',
  'linkedin_support@cs.linkedin.com',
  'caseresponse@linkedin.com',
  'dmarcreport@microsoft.com',
  'noreply-dmarc-support@google.com',
  'communications@mail.wio.io',
  'outreach@vantagesearchgroup.me',
  'mstubbs@vantagesearchgroup.me',
  'email-cf341bd4-2962-4e77-9f03-c64463e9de1c@test.mailpool.io',
]

describe('splitAddress', () => {
  it('lowercases and splits', () => {
    expect(splitAddress('Erwin.Dioso@TAQA.com')).toEqual({
      email: 'erwin.dioso@taqa.com', local: 'erwin.dioso', domain: 'taqa.com',
    })
  })
  it('refuses anything that is not an address', () => {
    for (const bad of ['', null, undefined, 'nope', '@taqa.com', 'erwin@', '  ']) {
      expect(splitAddress(bad).email).toBe('')
    }
  })
})

describe('classifyAddress', () => {
  it('accepts all 11 real work counterparties as people', () => {
    for (const addr of REAL_WORK_ADDRESSES) {
      const got = classifyAddress(addr, OWN)
      expect(got.kind, `${addr} should be a person`).toBe('person')
    }
  })

  it('rejects all 15 real noise senders — zero false positives', () => {
    for (const addr of REAL_NOISE_ADDRESSES) {
      const got = classifyAddress(addr, OWN)
      expect(got.kind, `${addr} should be rejected`).toBe('reject')
    }
  })

  it('treats candidate free-mail as personal, never as a new company contact', () => {
    for (const addr of [
      'maher.alsulami@gmail.com', 'azjalab@gmail.com', 'shuaa.ms@gmail.com',
      'abdullahabdulaziz95@hotmail.com', 'nefzaoui.amel@gmail.com',
      'woroudalohaly@gmail.com',
    ]) {
      expect(classifyAddress(addr, OWN).kind, addr).toBe('personal')
    }
  })

  it('treats a front desk as a role, not a person', () => {
    expect(classifyAddress('recruitment@adcouncil.ae', OWN).kind).toBe('role')
    expect(classifyAddress('info@e7group.ae', OWN).kind).toBe('role')
    expect(classifyAddress('careers@taqa.com', OWN).kind).toBe('reject')
  })

  it('does not mistake real surnames for machinery', () => {
    // The automated list is matched on a token boundary for exactly this
    // reason: "newsome" is a person, "newsletter" is not.
    expect(classifyAddress('t.newsome@adnoc.ae', OWN).kind).toBe('person')
    expect(classifyAddress('j.jobson@pif.gov.sa', OWN).kind).toBe('person')
    expect(classifyAddress('a.billingham@mubadala.ae', OWN).kind).toBe('person')
    expect(classifyAddress('r.infosys@acwapower.com', OWN).kind).toBe('person')
  })

  it('rejects the sender own addresses and own domains', () => {
    expect(classifyAddress('mstubbs@vantagesearchgroup.me', OWN).reason).toBe('self')
    expect(classifyAddress('anyone@vantagesearchgroup.me', OWN).reason).toBe('own_domain')
    expect(classifyAddress('hello@meetannie.ai', OWN).reason).toBe('own_domain')
  })
})

describe('cleanDisplayName', () => {
  it('keeps a real name', () => {
    expect(cleanDisplayName('Bayan AlKhalaf')).toBe('Bayan AlKhalaf')
  })
  it('strips an address the provider stuffed into the name slot', () => {
    expect(cleanDisplayName('Hannah Wild <hwild@adcouncil.ae>')).toBe('Hannah Wild')
  })
  it('flips Outlook surname-first', () => {
    expect(cleanDisplayName('AlKhalaf, Bayan')).toBe('Bayan AlKhalaf')
  })
  it('returns nothing when the name is only an address', () => {
    expect(cleanDisplayName('hwild@adcouncil.ae')).toBe('')
    expect(cleanDisplayName('')).toBe('')
  })
})

describe('nameFromAddress', () => {
  // Measured: this works for 3 of the 11 real addresses. That is why the
  // display name from the provider is the primary source and this is not.
  it('parses a dotted address', () => {
    expect(nameFromAddress('Christina.Westhuizen@e7group.ae')).toBe('Christina Westhuizen')
    expect(nameFromAddress('Erwin.Dioso@taqa.com')).toBe('Erwin Dioso')
  })
  it('gives up rather than guess on an initial-plus-surname', () => {
    expect(nameFromAddress('hwild@adcouncil.ae')).toBe('')
    expect(nameFromAddress('balkhalaf@al-akaria.com')).toBe('')
    expect(nameFromAddress('mzahid@limad.com')).toBe('')
  })
})

describe('detectAutoReply', () => {
  // Hannah Wild's real out-of-office, 3 Sep 2026.
  const hannah = {
    subject: 'Automatic reply: Follow up to call',
    bodyPlain: 'Thank you for your email. I am out of office until Monday 21st September and will respond upon my return.\n\nFor anything urgent please contact recruitment@adcouncil.ae',
    date: '2026-09-03T05:24:35.000Z',
  }

  it('spots it and reads the return date', () => {
    const got = detectAutoReply(hannah)
    expect(got.isAutoReply).toBe(true)
    expect(got.awayUntil).toBe('2026-09-21')
  })

  it('spots it from headers even when the subject looks normal', () => {
    const got = detectAutoReply({
      subject: 'Re: Recruitment - Vantage Search Group',
      bodyPlain: 'I am away.',
      headers: [{ name: 'Auto-Submitted', value: 'auto-replied' }],
      date: '2026-09-03T00:00:00.000Z',
    })
    expect(got.isAutoReply).toBe(true)
  })

  it('leaves a real reply alone', () => {
    // Bayan's actual reply, 2 Sep 2026.
    const got = detectAutoReply({
      subject: 'FW: Senior Marketing Manager profile',
      bodyPlain: 'Hi Michael\n\nSunday 1 pm is suitable\n\nThank you',
      date: '2026-09-02T09:20:19.000Z',
    })
    expect(got.isAutoReply).toBe(false)
    expect(got.awayUntil).toBeNull()
  })

  it('is an auto-reply even when no date can be read', () => {
    const got = detectAutoReply({
      subject: 'Out of office',
      bodyPlain: 'I am currently travelling with limited access to email.',
      date: '2026-09-03T00:00:00.000Z',
    })
    expect(got.isAutoReply).toBe(true)
    expect(got.awayUntil).toBeNull()
  })
})

describe('detectBounce', () => {
  // Why this exists at all, given classifyAddress already rejects
  // mailer-daemon, postmaster, bounce* and no-reply as automated: that filter
  // is an ADDRESS list, and Exchange and some mail appliances send a
  // non-delivery report from an ordinary-looking address that no address list
  // can anticipate. Two independent gates, so neither has to be complete.
  //
  // The stakes are higher than for an out-of-office. An OOO wrongly counted as
  // an answer stops a chase. A BOUNCE wrongly counted as an answer tells the
  // customer the message landed and was replied to, when it never arrived —
  // not an unproven claim, a false one.

  it('spots the canonical delivery status notification', () => {
    // RFC 3464. This header is what a DSN IS; nothing else sets it.
    const got = detectBounce({
      subject: 'Mail delivery failed',
      headers: [{ name: 'Content-Type', value: 'multipart/report; report-type=delivery-status; boundary="x"' }],
    })
    expect(got.isBounce).toBe(true)
    expect(got.reason).toBe('dsn_content_type')
  })

  it('spots the header Postfix and Exchange set on a failure', () => {
    expect(detectBounce({
      subject: 'Undeliverable: Al Akaria — hiring',
      headers: [{ name: 'X-Failed-Recipients', value: 'balkhalaf@al-akaria.com' }],
    }).isBounce).toBe(true)
  })

  it('spots the subjects the big providers actually send', () => {
    const subjects = [
      'Undeliverable: Recruitment - Vantage Search Group',
      'Delivery Status Notification (Failure)',
      'Mail delivery failed: returning message to sender',
      'Returned mail: see transcript for details',
      'Failure notice',
      'Message not delivered',
      'Delivery incomplete',
    ]
    for (const subject of subjects) {
      expect(detectBounce({ subject }).isBounce, subject).toBe(true)
    }
  })

  it('spots a DSN by its machine-readable body, with no useful headers', () => {
    // Unipile does not always hand back headers. The RFC 3464 field names
    // below appear nowhere in ordinary prose, which is what makes matching on
    // them safe against mail a person wrote.
    const got = detectBounce({
      subject: 'Re: Al Akaria — hiring',
      bodyPlain: [
        'This is the mail system at host mail.example.',
        '',
        'Final-Recipient: rfc822; balkhalaf@al-akaria.com',
        'Action: failed',
        'Diagnostic-Code: smtp; 550 5.1.1 User unknown',
      ].join('\n'),
    })
    expect(got.isBounce).toBe(true)
    expect(got.reason).toBe('dsn_body')
  })

  it('leaves a real reply alone even when it talks about mail failing', () => {
    // The check has to be structural rather than a phrase in the prose, or a
    // human sentence about a delivery problem would be read as a bounce and
    // the reply would be discarded. This is Bayan's real reply shape with the
    // most awkward possible content.
    const got = detectBounce({
      subject: 'Re: Senior Marketing Manager profile',
      bodyPlain: 'Hi Michael\n\nSorry, your last message failed to reach me and was returned — please resend the CV.\n\nBayan AlKhalaf',
    })
    expect(got.isBounce).toBe(false)
    expect(got.reason).toBeNull()
  })

  it('leaves an out-of-office alone — it is the other verdict, not this one', () => {
    // Hannah Wild's real out-of-office. It proves the address WORKS. Reading
    // it as a bounce would throw away the return date, which is the one
    // genuinely useful thing in it.
    expect(detectBounce({
      subject: 'Automatic reply: Follow up to call',
      bodyPlain: 'Thank you for your email. I am out of office until Monday 21st September.',
      headers: [{ name: 'Auto-Submitted', value: 'auto-replied' }],
    }).isBounce).toBe(false)
  })

  it('does not fire on an empty message', () => {
    expect(detectBounce({}).isBounce).toBe(false)
    expect(detectBounce({ subject: '', bodyPlain: '', headers: [] }).isBounce).toBe(false)
  })
})

describe('parseAwayUntil', () => {
  const ref = '2026-09-03T00:00:00.000Z'

  it('reads the shapes people actually write', () => {
    expect(parseAwayUntil('out of office until Monday 21st September', ref)).toBe('2026-09-21')
    expect(parseAwayUntil('back on 15 Oct', ref)).toBe('2026-10-15')
    expect(parseAwayUntil('I return on September 8 and will reply then', ref)).toBe('2026-09-08')
    expect(parseAwayUntil('away until 2 January 2027', ref)).toBe('2027-01-02')
  })

  it('rolls into next year when the date has clearly passed', () => {
    expect(parseAwayUntil('back on 4 January', ref)).toBe('2027-01-04')
  })

  it('returns null rather than guess', () => {
    // A wrong date here silently stops a real follow-up, so silence beats a guess.
    expect(parseAwayUntil('I am away for a couple of weeks', ref)).toBeNull()
    expect(parseAwayUntil('until further notice', ref)).toBeNull()
    expect(parseAwayUntil('back on 31 February', ref)).toBeNull()
    expect(parseAwayUntil('', ref)).toBeNull()
  })
})

describe('parseSignature', () => {
  // Bayan AlKhalaf's real signature block, exactly as it arrived.
  const bayan = `Hi Michael

Sunday 1 pm is suitable

Thank you

Bayan AlKhalaf
Organization Development Senior Manager

Tel: +966 11 4600000 Ext: 3118
Email: balkhalaf@al-akaria.com
Website: www.al-akaria.com
Saudi Real Estate Company, PO Box 3572
Kingdom Of Saudi Arabia, Riyadh 11481

This email and any attachments are confidential.`

  it('lifts the title and the direct line Apollo cannot sell you', () => {
    const got = parseSignature(bayan, { name: 'Bayan AlKhalaf' })
    expect(got.title).toBe('Organization Development Senior Manager')
    expect(got.phone).toBe('+966 11 4600000 ext 3118')
  })

  it('handles the other real signature in the same thread', () => {
    const shatha = `Shatha Aloqaily
Marketing & Communication Director

Tel: +966 11 4600000 Ext: 3773
Email: saloqaily@al-akaria.com`
    const got = parseSignature(shatha, { name: 'Shatha Aloqaily' })
    expect(got.title).toBe('Marketing & Communication Director')
    expect(got.phone).toBe('+966 11 4600000 ext 3773')
  })

  it('does not invent a title when the signature is just a name', () => {
    const got = parseSignature('Thanks\n\nOlaf\n', { name: 'Olaf Schleichert' })
    expect(got.title).toBeNull()
  })

  it('returns nothing when the person never signs', () => {
    const got = parseSignature('Sure, that works.', { name: 'Bayan AlKhalaf' })
    expect(got).toEqual({ title: null, phone: null })
  })

  it('does not read the legal disclaimer as a job title', () => {
    const got = parseSignature('Regards\n\nMuna Almakheeti\n\nThis e-mail and any files transmitted with it are confidential.', { name: 'Muna Almakheeti' })
    expect(got.title).toBeNull()
  })
})

describe('pickCounterparty', () => {
  const own = { ownAddresses: ['mstubbs@vantagesearchgroup.me'] }

  it('picks the recipient on an outbound message', () => {
    const got = pickCounterparty({
      from_attendee: { identifier: 'mstubbs@vantagesearchgroup.me', display_name: 'Michael Stubbs' },
      to_attendees: [{ identifier: 'balkhalaf@al-akaria.com', display_name: 'Bayan AlKhalaf' }],
    }, own)
    expect(got).toMatchObject({
      direction: 'out', email: 'balkhalaf@al-akaria.com',
      name: 'Bayan AlKhalaf', nameConfirmed: true, domain: 'al-akaria.com',
    })
  })

  it('picks the sender on an inbound message', () => {
    const got = pickCounterparty({
      from_attendee: { identifier: 'balkhalaf@al-akaria.com', display_name: 'Bayan AlKhalaf' },
      to_attendees: [{ identifier: 'mstubbs@vantagesearchgroup.me' }],
    }, own)
    expect(got).toMatchObject({ direction: 'in', email: 'balkhalaf@al-akaria.com' })
  })

  it('ignores people who were only copied', () => {
    // Being CC'd is not a conversation. Counting it is how a CRM fills up
    // with people nobody ever spoke to.
    const got = pickCounterparty({
      from_attendee: { identifier: 'mstubbs@vantagesearchgroup.me' },
      to_attendees: [{ identifier: 'balkhalaf@al-akaria.com', display_name: 'Bayan AlKhalaf' }],
      cc_attendees: [{ identifier: 'saloqaily@al-akaria.com', display_name: 'Shatha Aloqaily' }],
    }, own)
    expect(got.email).toBe('balkhalaf@al-akaria.com')
  })

  it('skips over the sender own address in the To line', () => {
    const got = pickCounterparty({
      from_attendee: { identifier: 'mstubbs@vantagesearchgroup.me' },
      to_attendees: [
        { identifier: 'mstubbs@vantagesearchgroup.me' },
        { identifier: 'oschleichert@sanamadvisory.com.sa', display_name: 'Olaf Schleichert' },
      ],
    }, own)
    expect(got.email).toBe('oschleichert@sanamadvisory.com.sa')
  })

  it('falls back to the address when there is no display name, and says so', () => {
    const got = pickCounterparty({
      from_attendee: { identifier: 'mstubbs@vantagesearchgroup.me' },
      to_attendees: [{ identifier: 'Christina.Westhuizen@e7group.ae' }],
    }, own)
    expect(got.name).toBe('Christina Westhuizen')
    expect(got.nameConfirmed).toBe(false)
  })

  it('returns null when there is nobody to attribute it to', () => {
    expect(pickCounterparty({ from_attendee: { identifier: 'mstubbs@vantagesearchgroup.me' }, to_attendees: [] }, own)).toBeNull()
    expect(pickCounterparty({}, own)).toBeNull()
  })
})
