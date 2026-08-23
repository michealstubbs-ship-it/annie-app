import React, { useState } from 'react'
import { useAuth } from '../contexts/AuthContext'

export default function Login() {
  const { signIn, signUp, resetPassword, resendConfirmation } = useAuth()
  const [mode, setMode] = useState('login') // 'login' | 'signup' | 'forgot'
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [showResend, setShowResend] = useState(false)
  const [showExistingAccount, setShowExistingAccount] = useState(false)

  const [form, setForm] = useState({
    email: '', password: '', fullName: '', firmName: '',
  })
  const [agreedToTerms, setAgreedToTerms] = useState(false)

  function update(field, value) {
    setForm(prev => ({ ...prev, [field]: value }))
    setError('')
    setSuccess('')
    setShowResend(false)
    setShowExistingAccount(false)
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setLoading(true)
    setError('')
    setSuccess('')
    setShowResend(false)
    setShowExistingAccount(false)

    try {
      if (mode === 'login') {
        const { error } = await signIn(form.email, form.password)
        if (error) {
          if (error.message?.toLowerCase().includes('email not confirmed')) {
            setError("Your email hasn't been confirmed yet.")
            setShowResend(true)
          } else {
            setError(error.message)
          }
        }
      } else if (mode === 'signup') {
        if (!form.fullName.trim()) return setError('Please enter your full name')
        if (!form.firmName.trim()) return setError('Please enter your firm name')
        if (form.password.length < 8) return setError('Password must be at least 8 characters')
        if (!agreedToTerms) return setError('Please agree to the Terms of Service and Privacy Policy to continue')

        const { data, error } = await signUp(form.email, form.password, form.fullName, form.firmName)
        if (error) {
          setError(error.message)
        } else if (data?.user && data.user.identities?.length === 0) {
          // Supabase returns a "successful" signUp with no identities when the email
          // already belongs to a confirmed account, to avoid leaking which emails are
          // registered. Show the real situation instead of a misleading "check your
          // email" message that no email will ever back up.
          setError('An account with this email already exists.')
          setShowExistingAccount(true)
        } else {
          setSuccess("Account created. Check your email to confirm it, then sign in below. If it doesn't arrive in a couple of minutes, check spam.")
        }
      } else if (mode === 'forgot') {
        if (!form.email.trim()) return setError('Enter your email first')
        const { error } = await resetPassword(form.email)
        if (error) setError(error.message)
        else setSuccess("If that email has an account, we've sent a password reset link.")
      }
    } finally {
      setLoading(false)
    }
  }

  async function handleResend() {
    if (!form.email.trim()) return setError('Enter your email first')
    setLoading(true)
    const { error } = await resendConfirmation(form.email)
    setLoading(false)
    if (error) setError(error.message)
    else {
      setSuccess('Confirmation email sent again. Check your inbox, and spam if it takes a minute.')
      setShowResend(false)
    }
  }

  return (
    <div className="min-h-screen bg-navy flex items-center justify-center px-4">
      <div className="w-full max-w-md">

        {/* Logo */}
        <div className="flex items-center gap-3 mb-10 justify-center">
          <svg width="48" height="48" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect width="36" height="36" rx="8" fill="#c9a84c"/>
            <path d="M18 3L29 33H25L18 13L11 33H7L18 3Z" fill="#0d1b3e"/>
            <rect x="10" y="22" width="16" height="3.2" rx="1.6" fill="#c9a84c"/>
          </svg>
          <div>
            <div className="text-white font-bold text-2xl leading-none">annie</div>
            <div className="text-gold text-xs font-semibold tracking-widest uppercase">BD Intelligence</div>
          </div>
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl p-8 shadow-2xl">
          <h1 className="text-2xl font-bold text-navy mb-1">
            {mode === 'login' ? 'Welcome back' : mode === 'signup' ? 'Create your account' : 'Reset your password'}
          </h1>
          <p className="text-gray-500 text-sm mb-6">
            {mode === 'login' ? 'Sign in to your Annie dashboard' : mode === 'signup' ? 'Start your free trial, no credit card needed' : "We'll email you a link to set a new password"}
          </p>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm mb-4">
              {error}
              {showResend && (
                <button type="button" onClick={handleResend} className="block mt-2 text-gold font-semibold hover:underline">
                  Resend confirmation email
                </button>
              )}
              {showExistingAccount && (
                <button type="button" onClick={() => { setMode('login'); setError(''); setSuccess(''); setShowExistingAccount(false) }} className="block mt-2 text-gold font-semibold hover:underline">
                  Sign in instead
                </button>
              )}
            </div>
          )}
          {success && (
            <div className="bg-green-50 border border-green-200 text-green-700 rounded-lg px-4 py-3 text-sm mb-4">
              {success}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === 'signup' && (
              <>
                <div>
                  <label className="label">Full name</label>
                  <input className="input" type="text" placeholder="Michael Stubbs" value={form.fullName} onChange={e => update('fullName', e.target.value)} required />
                </div>
                <div>
                  <label className="label">Firm name</label>
                  <input className="input" type="text" placeholder="Vantage Search Group" value={form.firmName} onChange={e => update('firmName', e.target.value)} required />
                </div>
              </>
            )}

            <div>
              <label className="label">Email address</label>
              <input className="input" type="email" placeholder="you@yourfirm.com" value={form.email} onChange={e => update('email', e.target.value)} required />
            </div>

            {mode !== 'forgot' && (
              <div>
                <div className="flex items-center justify-between">
                  <label className="label">Password</label>
                  {mode === 'login' && (
                    <button type="button" onClick={() => { setMode('forgot'); setError(''); setSuccess('') }} className="text-xs text-gold font-semibold hover:underline mb-1.5">
                      Forgot password?
                    </button>
                  )}
                </div>
                <input className="input" type="password" placeholder={mode === 'signup' ? 'Min. 8 characters' : '••••••••'} value={form.password} onChange={e => update('password', e.target.value)} required />
              </div>
            )}

            {mode === 'signup' && (
              <div className="flex items-start gap-2 pt-1">
                <input
                  id="agree-terms"
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 rounded border-gray-300 text-gold focus:ring-gold"
                  checked={agreedToTerms}
                  onChange={e => { setAgreedToTerms(e.target.checked); setError('') }}
                  required
                />
                <label htmlFor="agree-terms" className="text-xs text-gray-500 leading-relaxed">
                  I agree to Annie's{' '}
                  <a href="https://meetannie.ai/terms.html" target="_blank" rel="noopener noreferrer" className="text-gold font-semibold hover:underline">Terms of Service</a>
                  {' '}and{' '}
                  <a href="https://meetannie.ai/privacy.html" target="_blank" rel="noopener noreferrer" className="text-gold font-semibold hover:underline">Privacy Policy</a>.
                </label>
              </div>
            )}

            <button type="submit" disabled={loading || (mode === 'signup' && !agreedToTerms)} className="btn-primary w-full mt-2">
              {loading ? 'Please wait...' : mode === 'login' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Send reset link'}
            </button>
          </form>

          <div className="mt-6 text-center text-sm text-gray-500">
            {mode === 'login' && (
              <>Don't have an account?{' '}
                <button onClick={() => { setMode('signup'); setError(''); setSuccess('') }} className="text-gold font-semibold hover:underline">Sign up free</button>
              </>
            )}
            {mode === 'signup' && (
              <>Already have an account?{' '}
                <button onClick={() => { setMode('login'); setError(''); setSuccess('') }} className="text-gold font-semibold hover:underline">Sign in</button>
              </>
            )}
            {mode === 'forgot' && (
              <button onClick={() => { setMode('login'); setError(''); setSuccess('') }} className="text-gold font-semibold hover:underline">Back to sign in</button>
            )}
          </div>
        </div>

        {mode !== 'signup' && (
          <p className="text-center text-gray-500 text-xs mt-6">
            By using Annie you agree to our{' '}
            <a href="https://meetannie.ai/terms.html" target="_blank" rel="noopener noreferrer" className="text-gold font-semibold hover:underline">Terms of Service</a>
            {' '}and{' '}
            <a href="https://meetannie.ai/privacy.html" target="_blank" rel="noopener noreferrer" className="text-gold font-semibold hover:underline">Privacy Policy</a>
          </p>
        )}
      </div>
    </div>
  )
}
