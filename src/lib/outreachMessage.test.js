import { describe, it, expect } from 'vitest'
import { buildOutreachMessage, firstNameOf } from './outreachMessage.js'

describe('firstNameOf', () => {
  it('takes the first word of a full name', () => {
    expect(firstNameOf('Nick Carter')).toBe('Nick')
  })

  it('handles a single-word name', () => {
    expect(firstNameOf('Nick')).toBe('Nick')
  })

  it('handles missing input', () => {
    expect(firstNameOf('')).toBe('')
    expect(firstNameOf(null)).toBe('')
    expect(firstNameOf(undefined)).toBe('')
  })

  it('collapses extra whitespace', () => {
    expect(firstNameOf('  Nick   Carter ')).toBe('Nick')
  })
})

describe('buildOutreachMessage', () => {
  it('addresses the verified contact by first name and signs off with the sender and firm', () => {
    const msg = buildOutreachMessage({
      body: 'Saw the funding news at Acme — thought it was worth flagging.',
      contactFirstName: 'Naif',
      senderFirstName: 'Nick',
      firmName: 'Carter Search',
    })
    expect(msg).toBe(
      'Hi Naif,\n\nSaw the funding news at Acme — thought it was worth flagging.\n\nBest,\nNick\nCarter Search'
    )
  })

  it('falls back to a generic greeting when no contact name is known', () => {
    const msg = buildOutreachMessage({ body: 'Body text.', contactFirstName: '', senderFirstName: 'Nick', firmName: 'Carter Search' })
    expect(msg.startsWith('Hi there,\n\n')).toBe(true)
  })

  it('signs off with just the firm when the sender has no name on file', () => {
    const msg = buildOutreachMessage({ body: 'Body text.', contactFirstName: 'Naif', senderFirstName: '', firmName: 'Carter Search' })
    expect(msg).toBe('Hi Naif,\n\nBody text.\n\nCarter Search')
  })

  it('has no sign-off at all when neither sender name nor firm is known', () => {
    const msg = buildOutreachMessage({ body: 'Body text.', contactFirstName: '', senderFirstName: '', firmName: '' })
    expect(msg).toBe('Hi there,\n\nBody text.')
  })

  it('trims the body text', () => {
    const msg = buildOutreachMessage({ body: '  Body text.  ', contactFirstName: '', senderFirstName: '', firmName: '' })
    expect(msg).toBe('Hi there,\n\nBody text.')
  })
})
