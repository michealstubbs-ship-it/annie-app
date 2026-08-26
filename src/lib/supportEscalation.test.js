import { describe, it, expect } from 'vitest'
import { parseEscalation, ESCALATION_CATEGORIES } from './supportEscalation.js'

describe('parseEscalation', () => {
  it('passes ordinary replies through unchanged when there is no marker', () => {
    const text = "Your billing date is the 14th. The charge on the 2nd was the prorated amount."
    expect(parseEscalation(text)).toEqual({ displayText: text, category: null })
  })

  it('strips a valid marker from the end and returns its category', () => {
    const text = "I can't process a refund myself, flagging this for the team now.\n<<ESCALATE: refund_billing>>"
    const result = parseEscalation(text)
    expect(result.category).toBe('refund_billing')
    expect(result.displayText).toBe("I can't process a refund myself, flagging this for the team now.")
  })

  it('is case-insensitive on both the ESCALATE keyword and the category', () => {
    const text = "Flagging this.\n<<escalate: BUG_REPORT>>"
    expect(parseEscalation(text)).toEqual({ displayText: 'Flagging this.', category: 'bug_report' })
  })

  it('normalizes an unrecognized category to "unresolved" rather than dropping the escalation', () => {
    const text = "Passing this along.\n<<ESCALATE: something_weird>>"
    const result = parseEscalation(text)
    expect(result.category).toBe('unresolved')
    expect(result.displayText).toBe('Passing this along.')
  })

  it('tolerates one or two trailing blank lines between the reply and the marker', () => {
    const text = "Passing this along.\n\n<<ESCALATE: human_requested>>"
    expect(parseEscalation(text)).toEqual({ displayText: 'Passing this along.', category: 'human_requested' })
  })

  it('never leaves raw marker syntax visible to the customer', () => {
    const text = "Here you go.\n<<ESCALATE: gdpr_data_request>>"
    const { displayText } = parseEscalation(text)
    expect(displayText).not.toContain('ESCALATE')
    expect(displayText).not.toContain('<<')
  })

  it('does not false-positive on text that merely mentions escalation without the real marker syntax', () => {
    const text = "I might need to escalate this to the team if it keeps happening."
    expect(parseEscalation(text)).toEqual({ displayText: text, category: null })
  })

  it('only matches the marker at the very end of the reply, not mid-message', () => {
    const text = "<<ESCALATE: refund_billing>> is not a real command you can type here, but I can still help."
    expect(parseEscalation(text)).toEqual({ displayText: text, category: null })
  })

  it('handles non-string input defensively', () => {
    expect(parseEscalation(undefined)).toEqual({ displayText: undefined, category: null })
    expect(parseEscalation(null)).toEqual({ displayText: null, category: null })
  })

  it('exports the exact category list used to normalize unrecognized labels', () => {
    expect(ESCALATION_CATEGORIES).toEqual(['refund_billing', 'gdpr_data_request', 'bug_report', 'human_requested', 'unresolved'])
  })
})
