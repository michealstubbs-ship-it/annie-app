// Parsing logic for the LinkedIn CSV import (Connections.csv) — split out of
// LinkedInImport.jsx so it's directly unit-testable, same convention as
// linkedinImportMatch.js (see that file's own header).
//
// 2026-09-01: rewritten twice in the same day, both times off real customer
// reports.
//
// First pass added .xlsx-only support: LinkedIn's export zip contains
// Connections.csv, but on Windows a .csv file commonly opens directly in
// Excel by default — a customer who then saves it (Ctrl+S, or File > Save As
// without noticing Excel's own "keep as CSV?" prompt) can end up with a
// genuine binary .xlsx workbook instead of the plain-text CSV this importer
// originally only accepted.
//
// Michael's very next message made clear that was too narrow a fix:
// customers save this file in all sorts of ways depending on their OS,
// locale, and which spreadsheet app they used — a semicolon-delimited CSV
// (the default for Excel on most European Windows locales, where comma is
// already the decimal separator), a tab-delimited .txt ("Save As > Text"),
// a legacy .xls, an .ods (LibreOffice / Google Sheets "Download as"), or a
// UTF-8 CSV with a leading byte-order mark (Excel's own "CSV UTF-8" export
// always adds one). Rather than keep special-casing file extensions one at
// a time, every upload now goes through ONE universal reader
// (fileBufferToRows) built on SheetJS, which already knows how to parse all
// of the above natively — confirmed directly, not assumed: xlsx, xls, and
// ods all round-tripped correctly, and passing raw CSV/text bytes straight
// through (type: 'array', no extension check at all) correctly
// auto-detected comma, semicolon, and tab delimiters and handled quoted
// fields with embedded delimiters, in each case tested against this exact
// library and version before relying on it here. A file that isn't
// genuinely tabular data at all (a PDF, a photo, a Word doc) doesn't throw
// inside SheetJS either — it's a deliberately lenient parser — but produces
// nothing usable, so the existing downstream guards in LinkedInImport.jsx
// (rows.length < 2, then "no rows" once names can't be found) still catch
// it and show the same friendly error, unchanged.
//
// Using the SheetJS ("xlsx") package installed from cdn.sheetjs.com rather
// than the plain npm registry build: SheetJS stopped shipping security
// fixes to the npm package after a certain version (the npm "xlsx" listing
// has two known-unpatched vulnerabilities, prototype pollution and a ReDoS,
// confirmed via `npm audit` against it) and publishes patched builds only
// from their own CDN going forward — see package.json's own dependency URL.
import * as XLSX from 'xlsx'

// The one universal entry point: takes the raw bytes of WHATEVER file the
// customer uploaded (no extension check, no format assumption) and returns
// rows in the same [ [header...], [row...], ... ] shape parseCSV used to
// produce, so rowsToContacts below works identically regardless of the
// source format. header:1 asks for an array-of-arrays instead of
// object-keyed rows; raw:false formats cell values as display text (so a
// date or a number reads the way it would in a real CSV, not as a raw JS
// number); defval:'' fills a genuinely empty cell instead of leaving a hole
// that would otherwise become `undefined` and break the `.trim()` calls in
// rowsToContacts.
export function fileBufferToRows(arrayBuffer) {
  const workbook = XLSX.read(arrayBuffer, { type: 'array' })
  const firstSheetName = workbook.SheetNames[0]
  if (!firstSheetName) throw new Error('workbook has no sheets')
  const sheet = workbook.Sheets[firstSheetName]
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' })
  return rows.filter(r => Array.isArray(r) && r.some(v => v !== undefined && v !== null && String(v).trim()))
}

// Kept as a small, independently useful, independently tested pure CSV
// parser — no longer on the main upload path (fileBufferToRows now handles
// every format, CSV included, via SheetJS's own delimiter-detecting reader),
// but still exported since nothing about it is wrong, and a plain hand-
// rolled parser is a reasonable thing to keep around for a quick text-only
// need elsewhere.
export function parseCSV(text) {
  const rows = []
  let row = [], field = '', inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ }
        else inQuotes = false
      } else field += c
    } else {
      if (c === '"') inQuotes = true
      else if (c === ',') { row.push(field); field = '' }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
      else if (c === '\r') { /* skip */ }
      else field += c
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  return rows.filter(r => r.some(v => v && v.trim()))
}

export function findColumn(headers, candidates) {
  const lower = headers.map(h => String(h ?? '').toLowerCase().trim())
  for (const c of candidates) {
    const idx = lower.findIndex(h => h.includes(c))
    if (idx !== -1) return idx
  }
  return -1
}

// 2026-09-01, real customer file: LinkedIn's actual Connections.csv export
// leads with a "Notes:" disclaimer block — a "Notes:" row, a long quoted
// privacy-settings explanation, then a blank row — BEFORE the real header
// row. Every earlier build/test fixture (including the "any file format"
// SheetJS work shipped earlier the same day) assumed rows[0] was always the
// header, so this exact real-world file parsed to zero contacts: findColumn
// against ["Notes:","","","","","",""] matches nothing, every column index
// comes back -1, every row's name ends up empty, and the "no rows" error
// fires — even though the file has thousands of real, well-formed contacts
// two rows below where we were looking. Scan the first several rows for the
// one that actually looks like a header (has a "first name" cell) instead of
// assuming row 0; falls back to 0 (previous behavior) if nothing is found,
// so a file with no recognizable header still hits the same downstream
// "no rows" guard rather than crashing on a bad index.
export function findHeaderRowIndex(rows) {
  const limit = Math.min(rows.length, 10)
  for (let i = 0; i < limit; i++) {
    if (findColumn(rows[i], ['first name']) !== -1) return i
  }
  return 0
}

// Turns parsed rows (headers + data rows, from fileBufferToRows regardless
// of the original file format) into the contact shape the rest of the
// import flow uses.
export function rowsToContacts(rows) {
  const headerRowIdx = findHeaderRowIndex(rows)
  const headers = rows[headerRowIdx]
  rows = rows.slice(headerRowIdx)
  const firstIdx = findColumn(headers, ['first name'])
  const lastIdx = findColumn(headers, ['last name'])
  const companyIdx = findColumn(headers, ['company'])
  const titleIdx = findColumn(headers, ['position', 'title'])
  const urlIdx = findColumn(headers, ['url'])
  const emailIdx = findColumn(headers, ['email'])
  const dateIdx = findColumn(headers, ['connected on'])

  return rows.slice(1).map(r => ({
    name: [r[firstIdx], r[lastIdx]].map(v => String(v ?? '').trim()).filter(Boolean).join(' ').trim(),
    company: companyIdx !== -1 ? String(r[companyIdx] ?? '').trim() : '',
    title: titleIdx !== -1 ? String(r[titleIdx] ?? '').trim() : '',
    linkedin_url: urlIdx !== -1 ? String(r[urlIdx] ?? '').trim() : '',
    email: emailIdx !== -1 ? String(r[emailIdx] ?? '').trim() : '',
    connectedOn: dateIdx !== -1 ? String(r[dateIdx] ?? '').trim() : '',
  })).filter(c => c.name)
}
