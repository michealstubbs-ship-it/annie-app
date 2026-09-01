import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { parseCSV, findColumn, rowsToContacts, isSpreadsheetFile, sheetToCsvText } from './linkedinImportParse.js'

// 2026-09-01: added after a real customer report — Michael tried uploading
// the file LinkedIn's export actually produced after it opened in Excel and
// got saved from there, and the importer rejected it with a generic
// "Couldn't read that file." Root cause: a real .xlsx is a binary/zip
// workbook, and the importer only ever read the upload as plain text. These
// tests build a REAL .xlsx workbook in memory (via the same SheetJS library
// the app now uses to read one) and push it through the exact function the
// app calls, rather than only asserting against a hand-written CSV string.

describe('isSpreadsheetFile', () => {
  it('recognizes .xlsx and .xls, case-insensitively', () => {
    expect(isSpreadsheetFile('Connections.xlsx')).toBe(true)
    expect(isSpreadsheetFile('Connections.XLS')).toBe(true)
  })

  it('does not treat a real .csv as a spreadsheet file', () => {
    expect(isSpreadsheetFile('Connections.csv')).toBe(false)
  })

  it('handles a missing/empty filename without throwing', () => {
    expect(isSpreadsheetFile('')).toBe(false)
    expect(isSpreadsheetFile(undefined)).toBe(false)
  })
})

describe('parseCSV', () => {
  it('parses a simple comma-separated file with a header row', () => {
    const text = 'First Name,Last Name,Company\nJane,Doe,Acme Corp\n'
    expect(parseCSV(text)).toEqual([
      ['First Name', 'Last Name', 'Company'],
      ['Jane', 'Doe', 'Acme Corp'],
    ])
  })

  it('handles a quoted field containing a comma (e.g. "Cushman & Wakefield, Dubai")', () => {
    const text = 'Company\n"Cushman & Wakefield, Dubai"\n'
    expect(parseCSV(text)).toEqual([['Company'], ['Cushman & Wakefield, Dubai']])
  })

  it('handles an escaped double-quote inside a quoted field', () => {
    const text = 'Title\n"VP, ""Global"" Strategy"\n'
    expect(parseCSV(text)).toEqual([['Title'], ['VP, "Global" Strategy']])
  })

  it('drops blank rows', () => {
    const text = 'A,B\n\nx,y\n'
    expect(parseCSV(text)).toEqual([['A', 'B'], ['x', 'y']])
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
})

describe('sheetToCsvText — real .xlsx round-trip (the actual reported failure)', () => {
  it('converts a real in-memory .xlsx workbook (built the same way Excel would save one) back into parseable CSV text', () => {
    // Build a genuine workbook the same shape as LinkedIn's Connections.csv,
    // exactly what a customer gets after opening the export in Excel and
    // saving it — this is real binary xlsx data, not a CSV string.
    const worksheetData = [
      ['First Name', 'Last Name', 'URL', 'Email Address', 'Company', 'Position', 'Connected On'],
      ['Jarrett', 'Bunnin', 'https://www.linkedin.com/in/jarrett', '', 'Cushman & Wakefield', 'Manager - Strategy', '05-Aug-26'],
      ['Ash', 'Sharma', 'https://www.linkedin.com/in/ash', '', 'McKinsey & Company', 'Aerospace and Defense', '05-Aug-26'],
    ]
    const worksheet = XLSX.utils.aoa_to_sheet(worksheetData)
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1')
    const arrayBuffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' })

    const csvText = sheetToCsvText(arrayBuffer)
    const rows = parseCSV(csvText)
    const contacts = rowsToContacts(rows)

    expect(contacts).toHaveLength(2)
    expect(contacts[0]).toMatchObject({ name: 'Jarrett Bunnin', company: 'Cushman & Wakefield', title: 'Manager - Strategy' })
    expect(contacts[1]).toMatchObject({ name: 'Ash Sharma', company: 'McKinsey & Company', title: 'Aerospace and Defense' })
  })

  it('a non-workbook file (e.g. plain text renamed to .xlsx) does not throw inside sheetToCsvText itself — SheetJS is lenient and reads it as a one-cell sheet — but it never produces usable contacts, so the app-level "couldn\'t read that file" guard (rows.length < 2 in LinkedInImport.jsx) still catches it', () => {
    const notAWorkbook = new TextEncoder().encode('this is not a real xlsx file, just plain text').buffer
    const csvText = sheetToCsvText(notAWorkbook)
    const rows = parseCSV(csvText)
    // Exactly the condition LinkedInImport.jsx's handleFile checks
    // ("if (rows.length < 2) throw new Error('empty')") before ever
    // reaching rowsToContacts — confirming the real safety net is here,
    // one level up, not inside sheetToCsvText.
    expect(rows.length).toBeLessThan(2)
  })
})
