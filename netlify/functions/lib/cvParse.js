// Shared by parse-cv.js (single CV, on upload, auto-fills the candidate
// form) and parse-cvs-bulk-background.js (the "dump multiple CVs and Annie
// adds them" bulk path Michael asked for) — one real text-extraction +
// AI-structuring implementation, not two copies drifting apart the way the
// LinkedIn importer's own header warns against.
//
// Michael, several follow-ups in a row while this was being scoped: "really
// make sure the parse is solid, with all the information annie needs to
// monitor relevant candidates to either live lead jobs presented or any
// jobs that a customer may add themselves". Two concrete asks came out of
// that, both reflected below:
//  1. `titles`/`industries` — not just the ONE role/industry a recruiter
//     would type in by hand, but every title/industry Annie's own AI read
//     of the CV thinks this candidate's real experience genuinely supports
//     (title EQUIVALENCE — different wording for the same real role — not
//     a literal transcript of every job title in their career history;
//     confirmed directly with Michael, see this repo's own task history).
//     candidateMatch.js's prepareCandidatesForMatching folds these into its
//     existing token-overlap matching, so a richer parse here directly
//     makes both "Suggested candidates" (Jobs.jsx) and Today's Actions'
//     live_job matching more useful, with no separate matching path.
//  2. `nationality` — extracted ONLY when the CV states it explicitly (a
//     "Nationality:" line, a stated passport/citizenship, an explicit
//     "Saudi national" self-description) — never inferred from a
//     candidate's name or country of residence, which would be a
//     dangerous, biased guess dressed up as a fact. This feeds the
//     Saudi/Emirati-home-country-only matching gate in candidateMatch.js.
import mammoth from 'mammoth'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { stripAiArtifacts, sanitizeStringList } from '../../../src/lib/textSanitize.js'

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

const MAX_TITLES = 6
const MAX_INDUSTRIES = 4
// A real CV is prose, not a spreadsheet — several hundred to a few thousand
// words. Something that extracts to well under this is far more likely a
// scanned/image-only PDF (no real text layer at all) than a short CV, and
// the AI call is worth skipping rather than spending it on a near-empty
// prompt that can only produce a near-empty (or hallucinated) answer.
const MIN_USABLE_TEXT_LENGTH = 120
// Anthropic's own input is priced/capped by tokens, and a CV's actual
// content (name, roles, skills, dates) is always in the first couple of
// pages — a 40-page CV is vanishingly rare and almost always either a
// portfolio/appendix-heavy document or a mis-uploaded file. Capped, not
// dropped: still parsed, just not shipped in full to the model.
const MAX_TEXT_CHARS = 20000

function extFromFilename(filename) {
  const m = /\.([a-z0-9]+)$/i.exec(filename || '')
  return m ? m[1].toLowerCase() : ''
}

async function extractPdfText(bytes) {
  // useSystemFonts + the try/catch below: pdfjs-dist logs (not throws) a
  // "standardFontDataUrl" warning when a PDF references one of the base-14
  // fonts (Helvetica etc.) without embedding it, since it has no bundled
  // metrics to fall back on in a plain Node context — confirmed directly
  // this only affects glyph-WIDTH metrics used for layout, not the
  // Unicode text `getTextContent()` actually returns (which comes from the
  // PDF's own embedded ToUnicode/Differences encoding), so real extracted
  // text is correct either way. Left as a log line rather than chasing
  // down and bundling the standard-fonts data files into the function —
  // not worth the added deploy complexity for a cosmetic warning.
  const pdf = await getDocument({ data: bytes, useSystemFonts: true, isEvalSupported: false }).promise
  let text = ''
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    text += content.items.map(it => ('str' in it ? it.str : '')).join(' ') + '\n'
  }
  return text
}

async function extractDocxText(bytes) {
  const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) })
  return result.value || ''
}

// One universal entry point, same shape/spirit as linkedinImportParse.js's
// fileBufferToRows — takes raw bytes + the original filename, dispatches on
// extension, always returns a plain string (never throws for an
// UNSUPPORTED type — callers decide what a "couldn't read this" response
// looks like from an empty/short string, same lenient-parser precedent as
// the LinkedIn importer).
export async function extractCvText(bytes, filename) {
  const ext = extFromFilename(filename)
  let text = ''
  if (ext === 'pdf') text = await extractPdfText(bytes)
  else if (ext === 'docx') text = await extractDocxText(bytes)
  else if (ext === 'txt') text = new TextDecoder('utf-8').decode(bytes)
  else if (ext === 'doc') {
    // Legacy pre-2007 binary Word format — mammoth (and every practical
    // pure-JS library) only reads .docx. Rather than silently returning
    // nothing and letting the caller guess why auto-fill did nothing,
    // throw a specific, user-facing reason the frontend can show verbatim.
    throw new Error('Legacy .doc files can’t be auto-read yet — please re-save as PDF or .docx, or fill in the candidate’s details manually.')
  } else {
    throw new Error(`Unsupported file type${ext ? ` ".${ext}"` : ''} for CV auto-fill.`)
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_CHARS)
}

export function looksLikeUsableCvText(text) {
  return typeof text === 'string' && text.trim().length >= MIN_USABLE_TEXT_LENGTH
}

// ---------------------------------------------------------------------------
// AI extraction prompt + response parsing
// ---------------------------------------------------------------------------

export function buildCvExtractionSystemPrompt() {
  return `You are reading ONE real candidate's CV/resume for a recruitment CRM (Annie). Extract only what the text actually supports — never invent, guess, or fill in a plausible-sounding value for anything not genuinely present.

Return ONLY a single JSON object (no markdown fence, no commentary) with exactly these fields:
{
  "name": string or null,
  "email": string or null,
  "phone": string or null,
  "location": string or null,          // city/country they're based in, as stated
  "current_company": string or null,   // their most recent/current employer
  "current_role": string or null,      // their most recent/current job title, as stated
  "nationality": string or null,       // ONLY if the CV explicitly states a nationality/citizenship (e.g. "Nationality: Saudi Arabian", "Emirati national", a stated passport). NEVER infer this from their name, their current location, or any other clue — if it is not explicitly written, this MUST be null.
  "titles": string[],                  // up to 6 job titles — their actual current/recent title PLUS other real-world titles that mean the same seniority/function given their genuine experience (e.g. someone titled "Head of Growth" who has clearly run both marketing and growth functions could also list "VP Marketing"). This is about recognizing that different companies use different words for the same real role — not a list of every job title in their career history, and not a wish-list of unrelated roles.
  "industries": string[],              // up to 4 industries this candidate's real experience is genuinely relevant to — industries they have actually worked in, plus at most one clearly adjacent industry their skills transfer to. Do not list an industry with no real basis in the text.
  "years_experience": number or null    // total years of relevant professional experience, only if this can be reasonably calculated/stated from the text
}

Rules:
- Every field is grounded in the actual text. If something isn't in the CV, use null (or an empty array for titles/industries) — never fabricate.
- "titles" and "industries" reflect REAL equivalence/relevance, not creative expansion. When in doubt, include fewer, more defensible entries rather than more speculative ones.
- Return valid JSON only.`
}

// Balanced-brace JSON OBJECT extraction from a model's free-text response —
// same reasoning and same technique as jsonExtract.js's extractJson (strip a
// ```json fence if present, walk forward tracking string state and nesting
// depth so a brace inside a quoted value is never mistaken for structure),
// just for a single `{...}` object instead of a `[...]` array, since CV
// extraction is naturally one record, not a list. Not reusing extractJson
// itself since its shape-guard is array-specific.
export function extractJsonObject(text) {
  if (!text) return null
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1] : text

  const lastCloseIdx = candidate.lastIndexOf('}')
  if (lastCloseIdx === -1) return null

  let searchFrom = 0
  for (let attempt = 0; attempt < 50; attempt++) {
    const start = candidate.indexOf('{', searchFrom)
    if (start === -1 || start > lastCloseIdx) return null

    let depth = 0
    let inString = false
    let escaped = false
    let closedAt = -1
    for (let i = start; i < candidate.length; i++) {
      const ch = candidate[i]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') { inString = true; continue }
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) { closedAt = i; break }
      }
    }

    if (closedAt !== -1) {
      const slice = candidate.slice(start, closedAt + 1)
      try {
        const parsed = JSON.parse(slice)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
      } catch { /* not valid JSON after all — try the next '{' */ }
    }
    searchFrom = start + 1
  }
  return null
}

function cleanString(v) {
  if (typeof v !== 'string') return ''
  return stripAiArtifacts(v.trim())
}

// Turns the AI's raw (already-JSON-parsed) answer into the exact shape
// Candidates.jsx's form state expects, applying the same defensive
// sanitization every other AI-written field in this codebase goes through
// (stripAiArtifacts/sanitizeStringList — see textSanitize.js) before it
// ever reaches a form field or a database row. Tolerant of a malformed or
// partial response (missing fields, wrong types) — returns sensible empty
// defaults rather than throwing, since a partially-useful auto-fill is
// better than none and the recruiter reviews/edits every field before
// saving regardless.
export function sanitizeParsedCv(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  return {
    name: cleanString(r.name),
    email: cleanString(r.email),
    phone: cleanString(r.phone),
    location: cleanString(r.location),
    current_company: cleanString(r.current_company),
    current_role: cleanString(r.current_role),
    nationality: cleanString(r.nationality),
    titles: sanitizeStringList(r.titles, MAX_TITLES),
    industries: sanitizeStringList(r.industries, MAX_INDUSTRIES),
    years_experience: Number.isFinite(r.years_experience) ? r.years_experience : null,
  }
}

// True when the sanitized parse came back with nothing at all usable —
// callers use this to tell "Annie read the CV but it didn't contain real
// candidate details" apart from a genuine auto-fill, without duplicating
// the "what counts as usable" definition at each call site.
export function parsedCvIsEmpty(parsed) {
  return !parsed.name && !parsed.email && !parsed.phone && !parsed.current_role && !parsed.current_company && parsed.titles.length === 0
}
