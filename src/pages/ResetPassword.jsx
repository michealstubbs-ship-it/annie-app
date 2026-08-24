import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import ErrorBanner from '../components/ErrorBanner'

export default function ResetPassword() {
  const { updatePassword } = useAuth()
  const navigate = useNavigate()
  const [ready, setReady] = useState(false)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  useEffect(() => {
    // Supabase puts the recovery session in place automatically when arriving via the emailed link
    supabase.auth.getSession().then(({ data: { session } }) => {
      setReady(!!session)
      if (!session) setError('This reset link is invalid or has expired. Request a new one from the login page.')
    })
  }, [])

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    if (password.length < 8) return setError('Password must be at least 8 characters')
    if (password !== confirm) return setError("Passwords don't match")

    setLoading(true)
    const { error } = await updatePassword(password)
    setLoading(false)
    if (error) setError(error.message)
    else setDone(true)
  }

  return (
    <div className="min-h-screen bg-navy flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="flex items-center gap-3 mb-10 justify-center">
          <svg width="48" height="48" viewBox="0 0 36 36" fill="none">
            <rect width="36" height="36" rx="8" fill="#c9a84c"/>
            <path d="M18 3L29 33H25L18 13L11 33H7L18 3Z" fill="#0d1b3e"/>
            <rect x="10" y="22" width="16" height="3.2" rx="1.6" fill="#c9a84c"/>
          </svg>
          <div>
            <div className="text-white font-bold text-2xl leading-none">annie</div>
            <div className="text-gold text-xs font-semibold tracking-widest uppercase">BD Intelligence</div>
          </div>
        </div>

        <div className="bg-white rounded-2xl p-8 shadow-2xl">
          {done ? (
            <div className="text-center">
              <div className="w-14 h-14 rounded-full bg-yellow-50 border-2 border-gold flex items-center justify-center mx-auto mb-4">
                <span className="text-2xl">✓</span>
              </div>
              <h1 className="text-2xl font-bold text-navy mb-2">Password updated</h1>
              <p className="text-gray-500 text-sm mb-6">You're all set. Sign in with your new password.</p>
              <button onClick={() => navigate('/login')} className="btn-primary w-full">Go to sign in</button>
            </div>
          ) : (
            <>
              <h1 className="text-2xl font-bold text-navy mb-1">Set a new password</h1>
              <p className="text-gray-500 text-sm mb-6">Choose something you haven't used before.</p>

              <ErrorBanner>{error}</ErrorBanner>

              {ready && (
                <form onSubmit={handleSubmit} className="space-y-4">
                  <div>
                    <label className="label" htmlFor="reset-password-new">New password</label>
                    <input id="reset-password-new" className="input" type="password" placeholder="Min. 8 characters" value={password} onChange={e => setPassword(e.target.value)} required />
                  </div>
                  <div>
                    <label className="label" htmlFor="reset-password-confirm">Confirm new password</label>
                    <input id="reset-password-confirm" className="input" type="password" placeholder="Repeat your password" value={confirm} onChange={e => setConfirm(e.target.value)} required />
                  </div>
                  <button type="submit" disabled={loading} className="btn-primary w-full mt-2">
                    {loading ? 'Updating...' : 'Update password'}
                  </button>
                </form>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
