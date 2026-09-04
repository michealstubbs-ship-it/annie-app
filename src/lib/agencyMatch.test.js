import { describe, it, expect } from 'vitest'
import {
  looksLikeStaffingAgencyName,
  isStaffingAgencyIndustry,
  looksLikeStaffingAgency,
  looksLikeCommunityOrGroupName,
  looksLikeNonEmployerOrg,
} from './agencyMatch.js'

describe('looksLikeStaffingAgencyName', () => {
  it('matches common staffing/recruitment vocabulary', () => {
    expect(looksLikeStaffingAgencyName('Quik Hire Staffing')).toBe(true)
    expect(looksLikeStaffingAgencyName('Meridian Recruitment')).toBe(true)
    expect(looksLikeStaffingAgencyName('Sterling Executive Search')).toBe(true)
    expect(looksLikeStaffingAgencyName('Apex Talent Partners')).toBe(true)
    expect(looksLikeStaffingAgencyName('Global Headhunters LLC')).toBe(true)
    expect(looksLikeStaffingAgencyName('Vantage Search Group')).toBe(true)
  })

  it('does not flag a genuine company name', () => {
    expect(looksLikeStaffingAgencyName('Acme Ltd')).toBe(false)
    expect(looksLikeStaffingAgencyName('DP World')).toBe(false)
  })

  it('is false for an empty or missing name', () => {
    expect(looksLikeStaffingAgencyName('')).toBe(false)
    expect(looksLikeStaffingAgencyName(null)).toBe(false)
    expect(looksLikeStaffingAgencyName(undefined)).toBe(false)
  })
})

describe('isStaffingAgencyIndustry', () => {
  it('matches Apollo\'s own staffing/recruiting industry classification', () => {
    expect(isStaffingAgencyIndustry('Staffing and Recruiting')).toBe(true)
    expect(isStaffingAgencyIndustry('Human Resources')).toBe(false)
  })

  it('is false for an empty or missing industry', () => {
    expect(isStaffingAgencyIndustry('')).toBe(false)
    expect(isStaffingAgencyIndustry(null)).toBe(false)
  })
})

describe('looksLikeStaffingAgency', () => {
  it('is true if either the name or the industry says agency', () => {
    expect(looksLikeStaffingAgency('Quik Hire Staffing', null)).toBe(true)
    expect(looksLikeStaffingAgency('Acme Ltd', 'Staffing and Recruiting')).toBe(true)
    expect(looksLikeStaffingAgency('Acme Ltd', 'Manufacturing')).toBe(false)
  })
})

describe('looksLikeCommunityOrGroupName', () => {
  it('catches the real report: a meetup/user-group page surfaced as the hiring employer', () => {
    expect(looksLikeCommunityOrGroupName('COPADO User Group Hyderabad')).toBe(true)
    expect(looksLikeCommunityOrGroupName('AWS User Group SE')).toBe(true)
  })

  it('matches the other non-employer org vocabulary', () => {
    expect(looksLikeCommunityOrGroupName('Dubai Salesforce Meetup')).toBe(true)
    expect(looksLikeCommunityOrGroupName('Fintech Community Group Riyadh')).toBe(true)
    expect(looksLikeCommunityOrGroupName('CFA Society UAE')).toBe(false) // "Society" not in the pattern on purpose, see below
    expect(looksLikeCommunityOrGroupName('MENA HR Chapter')).toBe(true)
    expect(looksLikeCommunityOrGroupName('Finance Leaders Forum')).toBe(true)
    expect(looksLikeCommunityOrGroupName('INSEAD Alumni Network Dubai')).toBe(true)
  })

  it('does not flag a genuine company name, including one that only loosely resembles the pattern', () => {
    expect(looksLikeCommunityOrGroupName('Al-Futtaim Finance Company')).toBe(false)
    expect(looksLikeCommunityOrGroupName('DP World')).toBe(false)
    expect(looksLikeCommunityOrGroupName('Community Fibre')).toBe(true) // contains "Community" — see header comment: hard drop is the right call even for an edge case like this, a false positive here costs one lead, a false negative costs a wasted BD approach to a group with no hiring manager at all
  })

  it('is false for an empty or missing name', () => {
    expect(looksLikeCommunityOrGroupName('')).toBe(false)
    expect(looksLikeCommunityOrGroupName(null)).toBe(false)
    expect(looksLikeCommunityOrGroupName(undefined)).toBe(false)
  })
})

describe('looksLikeNonEmployerOrg', () => {
  it('is true for an agency name, an agency industry, or a community/group name', () => {
    expect(looksLikeNonEmployerOrg('Quik Hire Staffing', null)).toBe(true)
    expect(looksLikeNonEmployerOrg('Acme Ltd', 'Staffing and Recruiting')).toBe(true)
    expect(looksLikeNonEmployerOrg('AWS User Group SE', null)).toBe(true)
  })

  it('is false for a genuine hiring employer', () => {
    expect(looksLikeNonEmployerOrg('Al-Futtaim Finance Company', 'Financial Services')).toBe(false)
  })
})
