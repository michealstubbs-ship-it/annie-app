import { describe, it, expect } from 'vitest'
import {
  CONTACT_STATUSES,
  searchContacts,
  filterContactsByStatus,
  sortContacts,
  groupContactsByStatus,
} from './contactsView.js'

const CONTACTS = [
  { id: '1', name: 'Zara Khan', company: 'Acme', title: 'CFO', email: 'zara@acme.com', status: 'hot' },
  { id: '2', name: 'Amir Ali', company: 'Beta Ltd', title: 'CEO', email: 'amir@beta.com', status: 'warm' },
  { id: '3', name: 'Beth Cole', company: 'Acme', title: 'COO', email: 'beth@acme.com', status: 'hot' },
  { id: '4', name: 'Dana Fox', company: 'Gamma', title: 'VP', email: 'dana@gamma.com', status: 'cold' },
  { id: '5', name: 'Evan Grey', company: null, title: null, email: null, status: 'inactive' },
]

describe('searchContacts', () => {
  it('returns everything unchanged for a blank search', () => {
    expect(searchContacts(CONTACTS, '')).toEqual(CONTACTS)
    expect(searchContacts(CONTACTS, '   ')).toEqual(CONTACTS)
  })

  it('matches case-insensitively across name, company, title, and email', () => {
    expect(searchContacts(CONTACTS, 'zara').map(c => c.id)).toEqual(['1'])
    expect(searchContacts(CONTACTS, 'ACME').map(c => c.id)).toEqual(['1', '3'])
    expect(searchContacts(CONTACTS, 'ceo').map(c => c.id)).toEqual(['2'])
    expect(searchContacts(CONTACTS, 'beta.com').map(c => c.id)).toEqual(['2'])
  })

  it('does not throw on a contact with null fields', () => {
    expect(searchContacts(CONTACTS, 'evan').map(c => c.id)).toEqual(['5'])
  })
})

describe('filterContactsByStatus', () => {
  it('returns everything for "all" or a falsy status', () => {
    expect(filterContactsByStatus(CONTACTS, 'all')).toEqual(CONTACTS)
    expect(filterContactsByStatus(CONTACTS, null)).toEqual(CONTACTS)
    expect(filterContactsByStatus(CONTACTS, undefined)).toEqual(CONTACTS)
  })

  it('narrows to exactly the matching status', () => {
    expect(filterContactsByStatus(CONTACTS, 'hot').map(c => c.id)).toEqual(['1', '3'])
    expect(filterContactsByStatus(CONTACTS, 'client')).toEqual([])
  })
})

describe('sortContacts', () => {
  it('leaves order untouched for a missing or unrecognized sort key', () => {
    expect(sortContacts(CONTACTS, null)).toEqual(CONTACTS)
    expect(sortContacts(CONTACTS, 'email')).toEqual(CONTACTS)
  })

  it('sorts by name ascending and descending', () => {
    expect(sortContacts(CONTACTS, 'name', 'asc').map(c => c.id)).toEqual(['2', '3', '4', '5', '1'])
    expect(sortContacts(CONTACTS, 'name', 'desc').map(c => c.id)).toEqual(['1', '5', '4', '3', '2'])
  })

  it('sorts by company, treating null as sorting first', () => {
    expect(sortContacts(CONTACTS, 'company', 'asc').map(c => c.id)).toEqual(['5', '1', '3', '2', '4'])
  })

  it('does not mutate the input array', () => {
    const copy = [...CONTACTS]
    sortContacts(CONTACTS, 'name', 'asc')
    expect(CONTACTS).toEqual(copy)
  })
})

describe('groupContactsByStatus', () => {
  it('groups into status-ordered sections, omitting empty ones', () => {
    const groups = groupContactsByStatus(CONTACTS)
    expect(groups.map(g => g.status)).toEqual(['hot', 'warm', 'cold', 'inactive'])
    expect(groups.find(g => g.status === 'hot').contacts.map(c => c.id)).toEqual(['1', '3'])
    expect(groups.find(g => g.status === 'hot').label).toBe('Hot')
  })

  it('preserves the given order within each group rather than re-sorting', () => {
    const sorted = sortContacts(CONTACTS, 'name', 'asc')
    const groups = groupContactsByStatus(sorted)
    // 'Beth Cole' (id 3) sorts before 'Zara Khan' (id 1) alphabetically
    expect(groups.find(g => g.status === 'hot').contacts.map(c => c.id)).toEqual(['3', '1'])
  })

  it('buckets an unrecognized status value into an "Other" group instead of dropping it', () => {
    const withWeird = [...CONTACTS, { id: '6', name: 'Odd One', status: 'archived' }]
    const groups = groupContactsByStatus(withWeird)
    const other = groups.find(g => g.status === 'other')
    expect(other).toBeTruthy()
    expect(other.label).toBe('Other')
    expect(other.contacts.map(c => c.id)).toEqual(['6'])
  })

  it('returns an empty array for an empty contact list', () => {
    expect(groupContactsByStatus([])).toEqual([])
  })

  it('every known status is represented in the label map', () => {
    for (const status of CONTACT_STATUSES) {
      expect(groupContactsByStatus([{ id: 'x', status }])[0].label).toBeTruthy()
    }
  })
})
