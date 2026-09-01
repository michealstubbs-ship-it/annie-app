// Parsing logic for the LinkedIn CSV import (Connections.csv) — split out of
// LinkedInImport.jsx so it's directly unit-testable, same convention as
// linkedinImportMatch.js (see that file's own header).
//
// 2026-09-01: added real .xlsx/.xls support after a live customer report.
// LinkedIn's export zip contains Connections.csv, but on Windows a .csv file
// commonly opens directly in Excel by default — a customer who then saves it
// (Ctrl+S, or File > Save As without noticing Excel's own "keep as CSV?"
// prompt) can end up with a genuine binary .xlsx workbook instead of the
// plain-text CSV this importer originally only accepted. FileReader's
// readAsText() on that binary/zip data produced garbage, this file's
// parseCSV then failed, and the only feedback was a generic "Couldn't read
// that file," with nothing explaining why. Educating users to avoid this
// isn't reliable — Windows already shows the file in Excel, saving it is the
// natural next thing someone does — so both file types are now genuinely
// supported instead.
//
// Using the SheetJS ("xlsx") package installed from cdn.sheetjs.com rather
// than the plain npm registry build: SheetJS stopped shipping security
// fixes to the npm package after a certain version (the npm "xlsx" listing
// has two known-unpatched vulnerabilities, prototype pollution and a ReDoS,
// confirmed via `npm audit` against it) and publishes patched builds only
// from their own CDN going forward — see package.json's own dependency URL.
import * as XLSX from 'xlsx'

export function isSpreadsheetFile(fileName) {
  return /\.xlsx?$/i.test(fileName || '')
}

// Converts a real .xlsx/.xls workbook's first sheet back to plain CSV text,
// so the exact same, already-audited parseCSV/rowsToContacts pipeline below
// does the real work regardless of which file type the customer uploaded —
// rather than parsing the workbook's own row/cell structure a second,
// parallel way.
export function sheetToCsvText(arrayBuffer) {
  const workbook = XLSX.read(arrayBuffer, { type: 'array' })
  const firstSheetName = workbook.SheetNames[0]
  if (!firstSheetName) throw new Error('workbook has no sheets')
  return XLSX.utils.sheet_to_csv(workbook.Sheets[firstSheetName])
}

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
  const lower = headers.map(h => h.toLowerCase().trim())
  for (const c of candidates) {
    const idx = lower.findIndex(h => h.includes(c))
    if (idx !== -1) return idx
  }
  return -1
}

// Turns parsed rows (headers + data rows, from either a real CSV or an
// .xlsx sheet converted to CSV text above) into the contact shape the rest
// of the import flow uses.
export function rowsToContacts(rows) {
  const headers = rows[0]
  const firstIdx = findColumn(headers, ['first name'])
  const lastIdx = findColumn(headers, ['last name'])
  const companyIdx = findColumn(headers, ['company'])
  const titleIdx = findColumn(headers, ['position', 'title'])
  const urlIdx = findColumn(headers, ['url'])
  const emailIdx = findColumn(headers, ['email'])
  const dateIdx = findColumn(headers, ['connected on'])

  return rows.slice(1).map(r => ({
    name: [r[firstIdx], r[lastIdx]].filter(Boolean).join(' ').trim(),
    company: companyIdx !== -1 ? (r[companyIdx] || '').trim() : '',
    title: titleIdx !== -1 ? (r[titleIdx] || '').trim() : '',
    linkedin_url: urlIdx !== -1 ? (r[urlIdx] || '').trim() : '',
    email: emailIdx !== -1 ? (r[emailIdx] || '').trim() : '',
    connectedOn: dateIdx !== -1 ? (r[dateIdx] || '').trim() : '',
  })).filter(c => c.name)
}
