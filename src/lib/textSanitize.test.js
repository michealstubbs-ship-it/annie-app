// Regression coverage for the shared sanitizer both scanShared.js (server
// side, at signal write-time) and TodaysActions.jsx (client side, the
// per-candidate pitch call) route every AI-written field through — see this
// file's own header for why it's one implementation now instead of two.
import { describe, it, expect } from 'vitest'
import { stripAiArtifacts, sanitizeStringList, stripChatMarkdown } from './textSanitize.js'

describe('stripAiArtifacts', () => {
  it('strips <cite index="..."> markup the model sometimes emits during web search', () => {
    expect(stripAiArtifacts('Raises new fund <cite index="1-2">[1]</cite>')).toBe('Raises new fund')
  })

  it('strips stray numeric footnote markers like [1] or [2, 3]', () => {
    expect(stripAiArtifacts('This signals fresh capital for hiring.[2, 3]')).toBe('This signals fresh capital for hiring.')
  })

  it('collapses repeated whitespace left behind after stripping', () => {
    expect(stripAiArtifacts('The CFO <cite index="5-1">is the right door</cite>.')).toBe('The CFO is the right door.')
  })

  it('passes plain text through unchanged', () => {
    expect(stripAiArtifacts('A strong candidate is available.')).toBe('A strong candidate is available.')
  })

  it('handles empty/null/undefined input without throwing', () => {
    expect(stripAiArtifacts('')).toBe('')
    expect(stripAiArtifacts(null)).toBeNull()
    expect(stripAiArtifacts(undefined)).toBeUndefined()
  })
})

describe('sanitizeStringList', () => {
  it('bounds a list to the given max length', () => {
    expect(sanitizeStringList(['A', 'B', 'C', 'D'], 2)).toEqual(['A', 'B'])
  })

  it('strips artifacts out of each entry', () => {
    expect(sanitizeStringList(['Rival Co <cite index="1-1">[1]</cite>'], 3)).toEqual(['Rival Co'])
  })

  it('filters out non-string and empty entries', () => {
    expect(sanitizeStringList(['Real Co', '', null, 42, undefined], 5)).toEqual(['Real Co'])
  })

  it('returns an empty array for non-array input rather than throwing', () => {
    expect(sanitizeStringList(null, 3)).toEqual([])
    expect(sanitizeStringList(undefined, 3)).toEqual([])
    expect(sanitizeStringList('not an array', 3)).toEqual([])
  })
})

// 2026-09-02 audit fix, real customer report ("still too long to reply and
// stil using ** not natural chat"): Chat.jsx/SupportWidget.jsx render a
// message's content as raw text with no markdown parser, so the model
// writing "**bold**" anyway (despite the VOICE prompt asking it not to)
// showed up as literal asterisks on screen rather than formatting.
describe('stripChatMarkdown', () => {
  it('strips **bold** markers, keeping the words', () => {
    expect(stripChatMarkdown('**GCC Play:** worth checking their Aramco work.')).toBe('GCC Play: worth checking their Aramco work.')
  })

  it('strips __bold__ markers', () => {
    expect(stripChatMarkdown('This is __really__ important.')).toBe('This is really important.')
  })

  it('strips *italic* markers without touching a lone asterisk', () => {
    expect(stripChatMarkdown('That role pays *well* above market, 2 * 3 is still 6.')).toBe('That role pays well above market, 2 * 3 is still 6.')
  })

  it('strips markdown headers, keeping the heading text', () => {
    expect(stripChatMarkdown('## Alternative angle\nRetal secured financing.')).toBe('Alternative angle\nRetal secured financing.')
  })

  it('strips a leading bullet marker on each line, keeping the line as plain text', () => {
    expect(stripChatMarkdown('- Retal secured funding\n- Ayyan Investment too')).toBe('Retal secured funding\nAyyan Investment too')
  })

  it('leaves a real numbered sequence untouched — VOICE explicitly allows these', () => {
    expect(stripChatMarkdown('1. Send the intro email\n2. Follow up in 3 days')).toBe('1. Send the intro email\n2. Follow up in 3 days')
  })

  it('handles the exact real-report case: multiple bold section headers in one reply', () => {
    const input = '**Alternative: Real Estate Finance & Structured Funding:**\n\nRetal and Ayyan Investment have secured financing.\n\n**GCC Play:**\nIf they worked at ADNOC, that transfers directly.'
    const expected = 'Alternative: Real Estate Finance & Structured Funding:\n\nRetal and Ayyan Investment have secured financing.\n\nGCC Play:\nIf they worked at ADNOC, that transfers directly.'
    expect(stripChatMarkdown(input)).toBe(expected)
  })

  it('passes plain text through unchanged', () => {
    expect(stripChatMarkdown("That's a solid fit, worth reaching out today.")).toBe("That's a solid fit, worth reaching out today.")
  })

  it('handles empty/null/undefined input without throwing', () => {
    expect(stripChatMarkdown('')).toBe('')
    expect(stripChatMarkdown(null)).toBeNull()
    expect(stripChatMarkdown(undefined)).toBeUndefined()
  })
})
