import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { fileBufferToRows, parseCSV, findColumn, rowsToContacts } from './linkedinImportParse.js'

// 2026-09-01: written after two rounds of real customer reports — the first
// (a saved .xlsx wouldn't upload) fixed only .xlsx; Michael's very next
// message made clear customers save this file in many different ways, so
// the fix became one universal reader (fileBufferToRows) rather than a
// per-extension branch. These tests build REAL files in memory in each of
// the realistic formats (via the same SheetJS library the app uses to read
// them) and push them through the exact function the app calls, rather than
// only asserting against a hand-written CSV string.

function toArrayBuffer(text) {
  return new TextEncoder().encode(text).buffer
}

describe('fileBufferToRows — plain delimited text, any of the realistic delimiters', () => {
  it('reads a standard comma-delimited CSV (the original LinkedIn export format)', () => {
    const rows = fileBufferToRows(toArrayBuffer('First Name,Last Name,Company\nJane,Doe,Acme Corp\n'))
    expect(rows).toEqual([['First Name', 'Last Name', 'Company'], ['Jane', 'Doe', 'Acme Corp']])
  })

  it('reads a semicolon-delimited CSV (Excel\'s default export on most European Windows locales, where comma is the decimal separator)', () => {
    const rows = fileBufferToRows(toArrayBuffer('First Name;Last Name;Company\nJane;Doe;Acme Corp\n'))
    expect(rows).toEqual([['First Name', 'Last Name', 'Company'], ['Jane', 'Doe', 'Acme Corp']])
  })

  it('reads a tab-delimited .txt (Excel "Save As > Text (Tab delimited)")', () => {
    const rows = fileBufferToRows(toArrayBuffer('First Name\tLast Name\tCompany\nJane\tDoe\tAcme Corp\n'))
    expect(rows).toEqual([['First Name', 'Last Name', 'Company'], ['Jane', 'Doe', 'Acme Corp']])
  })

  it('reads a quoted field containing the delimiter itself (e.g. a company name with a comma in it)', () => {
    const rows = fileBufferToRows(toArrayBuffer('Company\n"Cushman & Wakefield, Dubai"\n'))
    expect(rows).toEqual([['Company'], ['Cushman & Wakefield, Dubai']])
  })

  it('reads a BOM-prefixed UTF-8 CSV (Excel\'s own "CSV UTF-8" export always adds a leading byte-order mark)', () => {
    const bomText = '﻿' + 'First Name,Last Name,Company\nJane,Doe,Acme Corp\n'
    const rows = fileBufferToRows(toArrayBuffer(bomText))
    // The BOM attaches to the first header cell's text, but findColumn's
    // substring match still finds 'first name' inside it — proven in the
    // rowsToContacts test below, not just asserted here.
    expect(rows[1]).toEqual(['Jane', 'Doe', 'Acme Corp'])
  })
})

describe('fileBufferToRows — real binary spreadsheet formats, built and read via the actual SheetJS library', () => {
  const sheetData = [
    ['First Name', 'Last Name', 'URL', 'Email Address', 'Company', 'Position', 'Connected On'],
    ['Jarrett', 'Bunnin', 'https://www.linkedin.com/in/jarrett', '', 'Cushman & Wakefield', 'Manager - Strategy', '05-Aug-26'],
  ]

  function buildWorkbookBuffer(bookType) {
    const worksheet = XLSX.utils.aoa_to_sheet(sheetData)
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1')
    return XLSX.write(workbook, { type: 'array', bookType })
  }

  it('reads a real .xlsx workbook (the exact failure Michael first reported — saved from Excel after opening the CSV export)', () => {
    const rows = fileBufferToRows(buildWorkbookBuffer('xlsx'))
    expect(rows[1]).toEqual(['Jarrett', 'Bunnin', 'https://www.linkedin.com/in/jarrett', '', 'Cushman & Wakefield', 'Manager - Strategy', '05-Aug-26'])
  })

  it('reads a legacy .xls (Excel 97-2003 binary format)', () => {
    const rows = fileBufferToRows(buildWorkbookBuffer('xls'))
    expect(rows[1]).toEqual(['Jarrett', 'Bunnin', 'https://www.linkedin.com/in/jarrett', '', 'Cushman & Wakefield', 'Manager - Strategy', '05-Aug-26'])
  })

  it('reads an .ods (LibreOffice / Google Sheets "Download as OpenDocument")', () => {
    const rows = fileBufferToRows(buildWorkbookBuffer('ods'))
    expect(rows[1]).toEqual(['Jarrett', 'Bunnin', 'https://www.linkedin.com/in/jarrett', '', 'Cushman & Wakefield', 'Manager - Strategy', '05-Aug-26'])
  })
})

describe('fileBufferToRows — edge cases', () => {
  it('a non-tabular file (e.g. plain prose saved with an .xlsx-like extension) reads as a single short row, not an unusable throw', () => {
    // SheetJS is deliberately lenient rather than throwing on this — the
    // real safety net is the row-count/contact-count checks in
    // LinkedInImport.jsx's handleFile, exercised in the next test.
    const rows = fileBufferToRows(toArrayBuffer('this is not a real spreadsheet file, just plain text'))
    expect(rows.length).toBeLessThan(2)
  })

  it('drops blank rows', () => {
    const rows = fileBufferToRows(toArrayBuffer('A,B\n\nx,y\n'))
    expect(rows).toEqual([['A', 'B'], ['x', 'y']])
  })
})

describe('parseCSV (kept as a small, independently tested pure CSV parser, no longer on the main upload path)', () => {
  it('parses a simple comma-separated file with a header row', () => {
    const text = 'First Name,Last Name,Company\nJane,Doe,Acme Corp\n'
    expect(parseCSV(text)).toEqual([
      ['First Name', 'Last Name', 'Company'],
      ['Jane', 'Doe', 'Acme Corp'],
    ])
  })

  it('handles a quoted field containing a comma', () => {
    const text = 'Company\n"Cushman & Wakefield, Dubai"\n'
    expect(parseCSV(text)).toEqual([['Company'], ['Cushman & Wakefield, Dubai']])
  })

  it('handles an escaped double-quote inside a quoted field', () => {
    const text = 'Title\n"VP, ""Global"" Strategy"\n'
    expect(parseCSV(text)).toEqual([['Title'], ['VP, "Global" Strategy']])
  })
})

describe('findColumn', () => {
  const headers = ['First Name', 'Last Name', 'URL', 'Email Address', 'Company', 'Position', 'Connected On']

  it('finds a column by a case-insensitive substring match', () => {
    expect(findColumn(headers, ['first name'])).toBe(0)
    expect(findColumn(headers, ['email'])).toBe(3)
  })

  it('tries candidates in order, e.g. "position" before "title"', () => {
    expect(findColumn(headers, ['position', 'title'])).toBe(5)
  })

  it('returns -1 when no candidate matches', () => {
    expect(findColumn(headers, ['phone number'])).toBe(-1)
  })

  it('still finds a header behind a leading BOM character (Excel\'s "CSV UTF-8" export)', () => {
    expect(findColumn(['﻿First Name', 'Last Name'], ['first name'])).toBe(0)
  })
})

describe('rowsToContacts', () => {
  it('maps a real Connections.csv-shaped set of rows into contact objects', () => {
    const rows = [
      ['First Name', 'Last Name', 'URL', 'Email Address', 'Company', 'Position', 'Connected On'],
      ['Jarrett', 'Bunnin', 'https://www.linkedin.com/in/jarrett', '', 'Cushman & Wakefield', 'Manager - Strategy', '05-Aug-26'],
    ]
    expect(rowsToContacts(rows)).toEqual([{
      name: 'Jarrett Bunnin',
      company: 'Cushman & Wakefield',
      title: 'Manager - Strategy',
      linkedin_url: 'https://www.linkedin.com/in/jarrett',
      email: '',
      connectedOn: '05-Aug-26',
    }])
  })

  it('drops a row with no name at all', () => {
    const rows = [
      ['First Name', 'Last Name', 'Company'],
      ['', '', 'Acme Corp'],
    ]
    expect(rowsToContacts(rows)).toEqual([])
  })

  it('works end-to-end off a real BOM-prefixed CSV read through fileBufferToRows', () => {
    const bomText = '﻿' + 'First Name,Last Name,Company\nJane,Doe,Acme Corp\n'
    const rows = fileBufferToRows(toArrayBuffer(bomText))
    expect(rowsToContacts(rows)).toEqual([{
      name: 'Jane Doe', company: 'Acme Corp', title: '', linkedin_url: '', email: '', connectedOn: '',
    }])
  })
})
