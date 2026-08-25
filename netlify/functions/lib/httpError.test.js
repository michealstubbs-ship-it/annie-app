import { describe, it, expect } from 'vitest'
import { jsonError } from './httpError.js'

describe('jsonError', () => {
  it('returns a Response with the given status', () => {
    const res = jsonError(404, 'Not found')
    expect(res.status).toBe(404)
  })

  it('sets Content-Type: application/json', () => {
    const res = jsonError(400, 'Bad request')
    expect(res.headers.get('Content-Type')).toBe('application/json')
  })

  it('bodies as { error: message } when no extra fields are given', async () => {
    const res = jsonError(401, 'Unauthorized')
    const body = await res.json()
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('merges extra fields alongside error', async () => {
    const res = jsonError(429, 'Too many requests', { retryAfter: 30 })
    const body = await res.json()
    expect(body).toEqual({ error: 'Too many requests', retryAfter: 30 })
  })

  it('lets an extra field of the same name override the message under `error`', async () => {
    const res = jsonError(500, 'Internal error', { error: 'more specific error' })
    const body = await res.json()
    expect(body.error).toBe('more specific error')
  })
})
