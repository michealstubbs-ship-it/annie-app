import { describe, it, expect } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import JSZip from 'jszip'
import {
  extractCvText,
  looksLikeUsableCvText,
  buildCvExtractionSystemPrompt,
  extractJsonObject,
  sanitizeParsedCv,
  parsedCvIsEmpty,
} from './cvParse.js'

// Real files, built through the actual authoring libraries (pdf-lib is
// already a dependency for invoice PDFs; JSZip is mammoth's own dependency,
// used here to build a minimal-but-valid .docx package) and pushed through
// the exact function the app calls to read them — same "test the real
// round trip, not a mock" precedent linkedinImportParse.test.js already
// set for the LinkedIn importer.

async function buildPdfBuffer(lines) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([600, 800])
  let y = 750
  for (const line of lines) {
    page.drawText(line, { x: 50, y, size: 12, font })
    y -= 20
  }
  return doc.save()
}

async function buildDocxBuffer(paragraphs) {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`)
  zip.folder('_rels').file('.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`)
  const body = paragraphs.map(p => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join('')
  zip.folder('word').file('document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${body}</w:body>
</w:document>`)
  return zip.generateAsync({ type: 'nodebuffer' })
}

describe('extractCvText', () => {
  it('extracts real text from a genuine PDF', async () => {
    const bytes = await buildPdfBuffer(['Jane Doe', 'Senior Product Manager at Acme Corp', 'Dubai, UAE | jane.doe@example.com'])
    const text = await extractCvText(bytes, 'cv.pdf')
    expect(text).toContain('Jane Doe')
    expect(text).toContain('Senior Product Manager at Acme Corp')
    expect(text).toContain('jane.doe@example.com')
  })

  it('extracts real text from a genuine .docx', async () => {
    const bytes = await buildDocxBuffer(['Jane Doe', 'Senior Product Manager at Acme Corp', 'Dubai, UAE | jane.doe@example.com'])
    const text = await extractCvText(bytes, 'cv.docx')
    expect(text).toContain('Jane Doe')
    expect(text).toContain('Senior Product Manager at Acme Corp')
  })

  it('reads a plain .txt file verbatim', async () => {
    const bytes = new TextEncoder().encode('Jane Doe\nSenior Product Manager')
    const text = await extractCvText(bytes, 'cv.txt')
    expect(text).toContain('Jane Doe')
  })

  it('throws a specific, user-facing message for legacy .doc files', async () => {
    await expect(extractCvText(new Uint8Array([1, 2, 3]), 'cv.doc')).rejects.toThrow(/re-save as PDF or \.docx/)
  })

  it('throws for a genuinely unsupported file type', async () => {
    await expect(extractCvText(new Uint8Array([1, 2, 3]), 'cv.pages')).rejects.toThrow(/Unsupported file type/)
  })

  it('caps extracted text at a sane length rather than shipping an unbounded blob to the AI call', async () => {
    const bytes = new TextEncoder().encode('word '.repeat(10000))
    const text = await extractCvText(bytes, 'cv.txt')
    expect(text.length).toBeLessThanOrEqual(20000)
  })
})

describe('looksLikeUsableCvText', () => {
  it('rejects an empty or near-empty extraction (e.g. a scanned, image-only PDF with no real text layer)', () => {
    expect(looksLikeUsableCvText('')).toBe(false)
    expect(looksLikeUsableCvText('   ')).toBe(false)
    expect(looksLikeUsableCvText('Jane Doe')).toBe(false) // a handful of words, not a real CV's worth of text
  })

  it('accepts a realistic amount of extracted text', () => {
    expect(looksLikeUsableCvText('word '.repeat(50))).toBe(true)
  })

  it('tolerates a non-string input without throwing', () => {
    expect(looksLikeUsableCvText(null)).toBe(false)
    expect(looksLikeUsableCvText(undefined)).toBe(false)
  })
})

describe('buildCvExtractionSystemPrompt', () => {
  it('names every field the caller relies on downstream', () => {
    const prompt = buildCvExtractionSystemPrompt()
    for (const field of ['name', 'email', 'phone', 'location', 'current_company', 'current_role', 'nationality', 'titles', 'industries', 'years_experience']) {
      expect(prompt).toContain(field)
    }
  })

  it('explicitly forbids inferring nationality from name/location', () => {
    const prompt = buildCvExtractionSystemPrompt()
    expect(prompt.toLowerCase()).toContain('never infer this from their name')
  })

  it('frames titles as equivalence, not a career-history transcript', () => {
    const prompt = buildCvExtractionSystemPrompt()
    expect(prompt).toContain('not a list of every job title in their career history')
  })
})

describe('extractJsonObject', () => {
  it('parses a clean JSON object', () => {
    expect(extractJsonObject('{"name":"Jane Doe"}')).toEqual({ name: 'Jane Doe' })
  })

  it('strips a ```json fence', () => {
    expect(extractJsonObject('```json\n{"name":"Jane Doe"}\n```')).toEqual({ name: 'Jane Doe' })
  })

  it('finds the real object behind leading narration text', () => {
    const text = 'Here is what I found: {"name":"Jane Doe","titles":["VP Marketing"]}'
    expect(extractJsonObject(text)).toEqual({ name: 'Jane Doe', titles: ['VP Marketing'] })
  })

  it('is not confused by a brace character inside a quoted string value', () => {
    const text = '{"name":"Jane Doe","notes":"led a team of {5} engineers"}'
    expect(extractJsonObject(text)).toEqual({ name: 'Jane Doe', notes: 'led a team of {5} engineers' })
  })

  it('returns null for text with no object at all', () => {
    expect(extractJsonObject('sorry, I could not read this CV')).toBeNull()
  })

  it('returns null for empty/nullish input', () => {
    expect(extractJsonObject('')).toBeNull()
    expect(extractJsonObject(null)).toBeNull()
  })

  it('skips a malformed candidate and finds a later valid one', () => {
    const text = '{"broken": ,} then actually {"name":"Jane Doe"}'
    expect(extractJsonObject(text)).toEqual({ name: 'Jane Doe' })
  })
})

describe('sanitizeParsedCv', () => {
  it('carries through a well-formed AI response', () => {
    const raw = {
      name: 'Jane Doe', email: 'jane@example.com', phone: '+971501234567',
      location: 'Dubai, UAE', current_company: 'Acme Corp', current_role: 'Senior Product Manager',
      nationality: 'Emirati', titles: ['VP Marketing', 'Growth Lead'], industries: ['Technology', 'Retail'],
      years_experience: 8,
    }
    expect(sanitizeParsedCv(raw)).toEqual(raw)
  })

  it('defaults every field safely when given nothing at all', () => {
    expect(sanitizeParsedCv(null)).toEqual({
      name: '', email: '', phone: '', location: '', current_company: '', current_role: '',
      nationality: '', titles: [], industries: [], years_experience: null,
    })
  })

  it('strips AI artifacts (inline citation markup) out of free-text fields', () => {
    const raw = { current_role: 'Senior PM <cite index="1-2">at Acme</cite>' }
    expect(sanitizeParsedCv(raw).current_role).toBe('Senior PM at Acme')
  })

  it('caps titles at 6 and industries at 4, same guard as every other AI-written list in this codebase', () => {
    const raw = { titles: Array.from({ length: 10 }, (_, i) => `Title ${i}`), industries: Array.from({ length: 10 }, (_, i) => `Industry ${i}`) }
    const result = sanitizeParsedCv(raw)
    expect(result.titles).toHaveLength(6)
    expect(result.industries).toHaveLength(4)
  })

  it('tolerates the wrong type for a list field (a string instead of an array) rather than throwing', () => {
    expect(sanitizeParsedCv({ titles: 'VP Marketing' }).titles).toEqual([])
  })

  it('only keeps years_experience when it is a real finite number', () => {
    expect(sanitizeParsedCv({ years_experience: 8 }).years_experience).toBe(8)
    expect(sanitizeParsedCv({ years_experience: 'a lot' }).years_experience).toBeNull()
    expect(sanitizeParsedCv({ years_experience: null }).years_experience).toBeNull()
  })
})

describe('parsedCvIsEmpty', () => {
  it('is true when nothing usable came back', () => {
    expect(parsedCvIsEmpty(sanitizeParsedCv(null))).toBe(true)
  })

  it('is false when at least a name was found', () => {
    expect(parsedCvIsEmpty(sanitizeParsedCv({ name: 'Jane Doe' }))).toBe(false)
  })

  it('is false when at least an inferred title was found even with no name', () => {
    expect(parsedCvIsEmpty(sanitizeParsedCv({ titles: ['VP Marketing'] }))).toBe(false)
  })
})
