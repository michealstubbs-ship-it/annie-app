import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { requireEnv, parseIntEnv } from './env.js'

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

describe('parseIntEnv', () => {
  it('falls back to the default when the var is unset (undefined)', () => {
    expect(parseIntEnv(undefined, 50)).toBe(50)
  })

  it('falls back to the default when the var is an empty string', () => {
    expect(parseIntEnv('', 50)).toBe(50)
  })

  it('falls back to the default when the var is not a number at all', () => {
    expect(parseIntEnv('not-a-number', 50)).toBe(50)
  })

  it('respects an explicit 0 rather than silently falling back — the bug this exists to fix', () => {
    expect(parseIntEnv('0', 50)).toBe(0)
  })

  it('respects any other explicit positive value', () => {
    expect(parseIntEnv('12', 50)).toBe(12)
  })

  it('respects a negative value rather than treating it as unset', () => {
    expect(parseIntEnv('-1', 50)).toBe(-1)
  })
})
