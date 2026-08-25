import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { requireEnv } from './env.js'

describe('requireEnv', () => {
  const KEYS = ['ANNIE_TEST_VAR_A', 'ANNIE_TEST_VAR_B', 'ANNIE_TEST_VAR_C']
  const saved = {}

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('reports ok: true and no missing vars when all are present', () => {
    process.env.ANNIE_TEST_VAR_A = 'a'
    process.env.ANNIE_TEST_VAR_B = 'b'
    const result = requireEnv(['ANNIE_TEST_VAR_A', 'ANNIE_TEST_VAR_B'])
    expect(result.ok).toBe(true)
    expect(result.missing).toEqual([])
    expect(result.values).toEqual({ ANNIE_TEST_VAR_A: 'a', ANNIE_TEST_VAR_B: 'b' })
  })

  it('reports ok: false and lists every missing var, in order', () => {
    process.env.ANNIE_TEST_VAR_B = 'b'
    const result = requireEnv(['ANNIE_TEST_VAR_A', 'ANNIE_TEST_VAR_B', 'ANNIE_TEST_VAR_C'])
    expect(result.ok).toBe(false)
    expect(result.missing).toEqual(['ANNIE_TEST_VAR_A', 'ANNIE_TEST_VAR_C'])
  })

  it('treats an empty-string env var as missing', () => {
    process.env.ANNIE_TEST_VAR_A = ''
    const result = requireEnv(['ANNIE_TEST_VAR_A'])
    expect(result.ok).toBe(false)
    expect(result.missing).toEqual(['ANNIE_TEST_VAR_A'])
  })

  it('returns ok: true with empty values/missing for an empty name list', () => {
    const result = requireEnv([])
    expect(result).toEqual({ values: {}, missing: [], ok: true })
  })

  it('still records the (undefined) value for a missing var in `values`', () => {
    const result = requireEnv(['ANNIE_TEST_VAR_A'])
    expect(result.values.ANNIE_TEST_VAR_A).toBeUndefined()
  })
})
